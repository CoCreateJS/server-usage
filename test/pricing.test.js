import test from 'node:test';
import assert from 'node:assert/strict';

import Usage, { calculatePrice } from '../src/index.js';

test('calculates token pricing without floating-point currency arithmetic', () => {
    const result = calculatePrice({
        usage: {
            input_tokens: 120,
            output_tokens: 40
        },
        pricing: [
            {
                meter: 'input_tokens',
                unit: 1000000,
                amount: 1250000,
                currency: 'USD',
                precision: 6
            },
            {
                meter: 'output_tokens',
                unit: 1000000,
                amount: 10000000,
                currency: 'USD',
                precision: 6
            }
        ],
        precision: 12
    });

    assert.deepEqual(
        result.charges.map(charge => charge.amount),
        ['150000000', '400000000']
    );
    assert.deepEqual(result.totals, [{
        amount: '550000000',
        currency: 'USD',
        precision: 12
    }]);
});

test('uses the same pricing contract for non-AI meters', () => {
    const result = calculatePrice({
        usage: { storage_bytes: 1500 },
        pricing: [{
            meter: 'storage_bytes',
            unit: 1000,
            amount: 2000000,
            currency: 'USD',
            precision: 6
        }],
        precision: 12
    });

    assert.equal(result.charges[0].quantity, '1500');
    assert.equal(result.totals[0].amount, '3000000000000');
    assert.equal(result.totals[0].precision, 12);
});

test('ignores pricing meters absent from the usage sample', () => {
    const result = calculatePrice({
        usage: { requests: 2 },
        pricing: [{
            meter: 'tokens',
            unit: 1,
            amount: 1,
            currency: 'USD',
            precision: 0
        }],
        precision: 12
    });

    assert.deepEqual(result.charges, []);
    assert.deepEqual(result.totals, []);
});

test('writes priced usage to tenant and platform ledgers', async () => {
    const writes = [];
    let balance = 5;
    const service = await Usage.init({
        organization_id: 'platform',
        host: 'test',
        crud: {
            send: async envelope => {
                writes.push(envelope);
                if (envelope.method === 'object.update') {
                    balance += envelope.object['$inc.balance'];
                } else if (
                    envelope.method === 'object.read' &&
                    envelope.array === 'organizations'
                ) {
                    return { object: [{ _id: 'tenant', balance }] };
                }
                return envelope;
            }
        }
    });

    await service.send({
        organization_id: 'tenant',
        type: 'requests',
        usage: { requests: 2 },
        pricing: [{
            meter: 'requests',
            unit: 1,
            amount: 500000,
            currency: 'USD',
            precision: 6
        }],
        reference: { request_id: 'request-1' },
        socket: { purpose: 'application data' }
    });
    service.stop();

    assert.equal(writes.length, 4);
    assert.equal(writes[0].organization_id, 'tenant');
    assert.equal(writes[0].object.direction, 'debit');
    assert.equal(writes[0].object.amount, '1000000000000');
    assert.equal(writes[0].object.reference.request_id, 'request-1');
    assert.deepEqual(writes[0].object.socket, { purpose: 'application data' });
    assert.equal(writes[1].organization_id, 'platform');
    assert.equal(writes[1].object.organization, 'tenant');
    assert.equal(writes[1].object.processed, false);
    assert.equal(balance, 4);
});

test('records incoming funds as credits in the same ledger', async () => {
    const writes = [];
    let balance = 0;
    const service = await Usage.init({
        organization_id: 'platform',
        host: 'test',
        crud: {
            send: async envelope => {
                writes.push(envelope);
                if (envelope.method === 'object.update') {
                    balance += envelope.object['$inc.balance'];
                } else if (
                    envelope.method === 'object.read' &&
                    envelope.array === 'organizations'
                ) {
                    return { object: [{ _id: 'tenant', balance }] };
                }
                return envelope;
            }
        }
    });

    const entry = await service.credit({
        organization_id: 'tenant',
        socket: { purpose: 'application data' },
        type: 'funds',
        amount: 2500000,
        currency: 'usd',
        precision: 6,
        reference: {
            provider: 'stripe',
            transaction_id: 'payment-1'
        }
    });
    service.stop();

    assert.equal(entry.direction, 'credit');
    assert.deepEqual(entry.socket, { purpose: 'application data' });
    assert.equal(entry.amount, '2500000000000');
    assert.equal(entry.currency, 'USD');
    assert.deepEqual(entry.sourceAmount, {
        amount: '2500000',
        currency: 'USD',
        precision: 6
    });
    assert.equal(writes.length, 4);
    assert.equal(writes[0].array, 'servers_usage');
    assert.equal(writes[0].object.direction, 'credit');
    assert.equal(writes[1].object.organization, 'tenant');
    assert.equal(writes[1].object.reference.transaction_id, 'payment-1');
    assert.equal(balance, 2.5);
});

test('stores a successful Stripe payment before applying its credit', async () => {
    const writes = [];
    const transactions = [];
    let balance = 0;
    let nextId = 1;
    const service = await Usage.init({
        organization_id: 'platform',
        host: 'test',
        crud: {
            send: async envelope => {
                writes.push(envelope);
                if (envelope.array === 'transactions') {
                    if (envelope.method === 'object.read') {
                        const query = envelope.filter.query;
                        return {
                            object: transactions.filter(item =>
                                item.provider === query.provider &&
                                item.provider_payment_id === query.provider_payment_id
                            )
                        };
                    }
                    if (envelope.method === 'object.create') {
                        const transaction = {
                            ...envelope.object,
                            _id: `transaction-${nextId++}`
                        };
                        transactions.push(transaction);
                        return { object: [transaction] };
                    }
                    if (envelope.method === 'object.update') {
                        const transaction = transactions.find(item => item._id === envelope.object._id);
                        Object.assign(transaction, envelope.object);
                        return { object: [transaction] };
                    }
                }
                if (envelope.method === 'object.update') {
                    balance += envelope.object['$inc.balance'];
                } else if (
                    envelope.method === 'object.read' &&
                    envelope.array === 'organizations'
                ) {
                    return { object: [{ _id: 'tenant', balance }] };
                }
                return envelope;
            }
        }
    });

    const payment = await service.payment({
        organization_id: 'tenant',
        provider: 'stripe',
        event_id: 'evt_1',
        payment_intent_id: 'pi_1',
        amount: 5000,
        currency: 'usd',
        precision: 2,
        status: 'succeeded',
        customer_id: 'cus_1',
        payment_method_id: 'pm_1'
    });
    const duplicate = await service.payment({
        organization_id: 'tenant',
        provider: 'stripe',
        event_id: 'evt_1',
        payment_intent_id: 'pi_1',
        amount: 5000,
        currency: 'usd',
        precision: 2,
        status: 'succeeded'
    });
    service.stop();

    assert.equal(payment.duplicate, false);
    assert.equal(payment.transaction.amount, 50);
    assert.equal(payment.transaction.provider_amount, '5000');
    assert.equal(payment.transaction.ledger_status, 'applied');
    assert.equal(payment.ledger.reference.transaction_id, 'transaction-1');
    assert.equal(duplicate.duplicate, true);
    assert.equal(transactions.length, 1);
    assert.equal(balance, 50);
    assert.equal(
        writes.filter(write => write.array === 'servers_usage').length,
        2
    );
});

test('emits the organization gate after a debit depletes the balance', async () => {
    let balance = 0.25;
    const service = await Usage.init({
        organization_id: 'platform',
        host: 'test',
        crud: {
            send: async envelope => {
                if (envelope.method === 'object.update') {
                    balance += envelope.object['$inc.balance'];
                } else if (
                    envelope.method === 'object.read' &&
                    envelope.array === 'organizations'
                ) {
                    return { object: [{ _id: 'tenant', balance }] };
                }
                return envelope;
            }
        }
    });

    const balanceEvent = new Promise(resolve => {
        process.once('organization.balance', resolve);
    });
    await service.send({
        organization_id: 'tenant',
        type: 'requests',
        usage: { requests: 1 },
        pricing: [{
            meter: 'requests',
            unit: 1,
            amount: 500000,
            currency: 'USD',
            precision: 6
        }]
    });
    service.stop();

    const event = await balanceEvent;
    assert.equal(balance, -0.25);
    assert.equal(event.organizationBalance, false);
    assert.equal(event.balance, -0.25);
});
