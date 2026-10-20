/********************************************************************************
 * Copyright (C) 2026 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 ********************************************************************************/

import config from '@cocreate/config';
import { getValueFromObject, dotNotationToObject } from '@cocreate/utils';

let server = null;                               // Reference to the main CoCreateServer instance
let platformOrgId = 'platform';                 // Master platform organization ID
let isRunning = false;                          // Service execution flag
let listenersBound = false;                     // Process event listener guard
let usageConfig = {};                           // In-memory configuration registry

function logPrefix() {
    const workerId = server?.workerId || process.env.WORKER_ID;
    return `[@cocreate/usage] ${workerId ? `[WORKER ${workerId}]` : '[MASTER]'}`;
}

// Default configuration settings
const defaults = {
    enabled: true,
    flushThresholdBytes: 10 * 1024 * 1024, // 10 Megabyte flush threshold for platform ledger
    tenantIntervalMs: 60 * 1000,           // 1 Minute interval for tenant usage stream
    ledgerPrecision: 12                    // Fixed-point precision for calculated charges
};

// Double-buffer map tracking separate platform and tenant blocks per organization
// Key: organization_id -> Value: { tenant, platform, tenantTimer }
const bandwidthMap = new Map();

// AI usage is grouped per tenant, provider, and model. Tenant and platform
// buffers are kept separately so each flush can be routed to its own database.
const aiUsageMap = new Map();

// Priced usage is serialized per organization so ledger writes preserve the
// same order as the usage events that produced them.
const ledgerQueues = new Map();

const aiTokenFields = [
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'cacheReadTokens',
    'cacheWriteTokens'
];

/**
 * Loads usage tracking configuration using @cocreate/config and queries database overrides.
 */
async function loadUsageConfig() {
    try {
        const sysConfig = await config.get('usage') || await config.get('servers_usage');
        let dbConfig = null;

        if (server && (server.organization_id || platformOrgId)) {
            dbConfig = await config.query({
                type: 'usage',
                organization_id: server.organization_id || platformOrgId,
                server: server.host
            });
        }

        if (sysConfig) dotNotationToObject(usageConfig, sysConfig);
        if (dbConfig) dotNotationToObject(usageConfig, dbConfig);
    } catch (err) {
        console.error(`${logPrefix()} Error loading configuration:`, err);
    }
    return usageConfig;
}

function getFlushThresholdBytes() {
    const val = getValueFromObject(usageConfig, 'flushThresholdBytes');
    return parseInt(val, 10) || defaults.flushThresholdBytes;
}

function getTenantIntervalMs() {
    const val = getValueFromObject(usageConfig, 'tenantIntervalMs');
    return parseInt(val, 10) || defaults.tenantIntervalMs;
}

function getLedgerPrecision() {
    const val = getValueFromObject(usageConfig, 'ledgerPrecision');
    const precision = Number.parseInt(val, 10);
    return Number.isInteger(precision) && precision >= 0 && precision <= 18
        ? precision
        : defaults.ledgerPrecision;
}

function initEventListeners() {
    if (listenersBound) return;
    listenersBound = true;

    process.on('usage', (options) => {
        Promise.resolve(send(options)).catch(error => {
            console.error(`${logPrefix()} Failed to process usage event:`, error);
        });
    });

    process.on('organization.evicted', (orgId) => {
        flushOrg(orgId).catch(err => {
            console.error(`${logPrefix()} Error flushing org ${orgId} on deletion:`, err);
        });
    });

    const shutdownHandler = async () => {
        try {
            await save();
        } catch (err) {
            console.error(`${logPrefix()} Error during shutdown save:`, err);
        }
    };

    process.on('beforeExit', shutdownHandler);
}

/**
 * Calculates the number of bytes represented by a usage payload.
 * Supports binary data, strings, JSON-compatible objects, and primitives.
 *
 * @param {*} data - Payload to measure
 * @returns {number} Payload size in bytes
 */
function calculatePayloadBytes(data) {
    if (data === null || data === undefined) return 0;

    try {
        if (Buffer.isBuffer(data)) {
            return data.length;
        }

        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
            return data.byteLength || 0;
        }

        if (typeof data === 'string') {
            return Buffer.byteLength(data, 'utf8');
        }

        if (typeof data === 'object') {
            return Buffer.byteLength(JSON.stringify(data), 'utf8');
        }

        return Buffer.byteLength(String(data), 'utf8');
    } catch (error) {
        console.error(`${logPrefix()} Failed to calculate payload bytes:`, error);
        return 0;
    }
}

function toUnsignedBigInt(value, label) {
    if (typeof value === 'bigint') {
        if (value >= 0n) return value;
    } else if (typeof value === 'number') {
        if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    } else if (typeof value === 'string' && /^\d+$/.test(value)) {
        return BigInt(value);
    }

    throw new TypeError(`${label} must be a non-negative integer.`);
}

function cloneSerializable(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value, (key, item) => {
        if (typeof item === 'bigint') return item.toString();
        if (typeof item === 'function') return undefined;
        return item;
    }));
}

function hasResponseError(response) {
    if (!response?.error) return false;
    return !Array.isArray(response.error) || response.error.length > 0;
}

/**
 * Calculates fixed-point charges from a resolved usage/pricing contract.
 * Every returned amount is an integer string at the returned precision,
 * avoiding floating-point currency arithmetic.
 */
function calculatePrice({ usage = {}, pricing = [], precision } = {}) {
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
        throw new TypeError('usage must be an object keyed by meter.');
    }
    if (!Array.isArray(pricing)) {
        throw new TypeError('pricing must be an array.');
    }

    const configuredPrecision = precision ?? getLedgerPrecision();
    const ratePrecisions = pricing.map(rate => Number(rate?.precision ?? 0));
    const ledgerPrecision = Math.max(configuredPrecision, ...ratePrecisions, 0);
    if (!Number.isInteger(ledgerPrecision) || ledgerPrecision < 0 || ledgerPrecision > 18) {
        throw new RangeError('Ledger precision must be an integer between 0 and 18.');
    }

    const charges = [];
    const totalByCurrency = new Map();

    for (const rate of pricing) {
        if (!rate || typeof rate !== 'object' || !rate.meter) continue;
        if (usage[rate.meter] === undefined || usage[rate.meter] === null) continue;

        const quantity = toUnsignedBigInt(usage[rate.meter], `usage.${rate.meter}`);
        if (quantity === 0n) continue;

        const unit = toUnsignedBigInt(rate.unit, `pricing.${rate.meter}.unit`);
        if (unit === 0n) {
            throw new RangeError(`pricing.${rate.meter}.unit must be greater than zero.`);
        }

        const rateAmount = toUnsignedBigInt(
            rate.amount,
            `pricing.${rate.meter}.amount`
        );
        const ratePrecision = Number(rate.precision ?? 0);
        if (!Number.isInteger(ratePrecision) || ratePrecision < 0 || ratePrecision > ledgerPrecision) {
            throw new RangeError(
                `pricing.${rate.meter}.precision must be between 0 and ${ledgerPrecision}.`
            );
        }

        const scale = 10n ** BigInt(ledgerPrecision - ratePrecision);
        const numerator = quantity * rateAmount * scale;
        const calculatedAmount = (numerator + unit / 2n) / unit;
        const currency = String(rate.currency || 'USD').toUpperCase();

        charges.push({
            meter: rate.meter,
            quantity: quantity.toString(),
            amount: calculatedAmount.toString(),
            currency,
            precision: ledgerPrecision,
            rate: cloneSerializable(rate)
        });
        totalByCurrency.set(
            currency,
            (totalByCurrency.get(currency) || 0n) + calculatedAmount
        );
    }

    const totals = [...totalByCurrency.entries()].map(([currency, amount]) => ({
        amount: amount.toString(),
        currency,
        precision: ledgerPrecision
    }));

    return { charges, totals, precision: ledgerPrecision };
}

function normalizeLedgerAmount(amount, precision = 0, ledgerPrecision = getLedgerPrecision()) {
    const sourceAmount = toUnsignedBigInt(amount, 'amount');
    const sourcePrecision = Number(precision);

    if (!Number.isInteger(sourcePrecision) || sourcePrecision < 0 || sourcePrecision > 18) {
        throw new RangeError('precision must be an integer between 0 and 18.');
    }
    if (!Number.isInteger(ledgerPrecision) || ledgerPrecision < sourcePrecision || ledgerPrecision > 18) {
        throw new RangeError(
            `Ledger precision must be an integer between ${sourcePrecision} and 18.`
        );
    }

    return {
        amount: (sourceAmount * 10n ** BigInt(ledgerPrecision - sourcePrecision)).toString(),
        precision: ledgerPrecision
    };
}

function fixedAmountToNumber(amount, precision) {
    const integerAmount = toUnsignedBigInt(amount, 'amount');
    const divisor = 10 ** Number(precision);
    const value = Number(integerAmount) / divisor;

    if (!Number.isFinite(value)) {
        throw new RangeError('Ledger amount is too large for the balance projection.');
    }
    return value;
}

function createPricedUsageObject(organization_id, options) {
    const { charges, totals } = calculatePrice(options);
    const excluded = new Set([
        'organization_id',
        'usage',
        'pricing',
        'sample',
        'data',
        'payload',
        'socket'
    ]);
    const metadata = {};

    for (const [key, value] of Object.entries(options)) {
        if (excluded.has(key) || value === undefined || typeof value === 'function') continue;
        metadata[key] = cloneSerializable(value);
    }

    const total = totals.length === 1 ? totals[0] : null;

    return {
        ...metadata,
        organization_id,
        direction: 'debit',
        usage: cloneSerializable(options.usage),
        pricing: cloneSerializable(options.pricing),
        charges,
        totals,
        ...(total && {
            amount: total.amount,
            currency: total.currency,
            precision: total.precision
        }),
        totalRequests: Number(options.totalRequests) || 1
    };
}

function createCreditObject(organization_id, options) {
    const ledgerPrecision = getLedgerPrecision();
    const normalized = normalizeLedgerAmount(
        options.amount,
        options.precision ?? 0,
        ledgerPrecision
    );
    const currency = String(options.currency || 'USD').toUpperCase();
    const excluded = new Set([
        'organization_id',
        'direction',
        'amount',
        'currency',
        'precision',
        'socket'
    ]);
    const metadata = {};

    for (const [key, value] of Object.entries(options)) {
        if (excluded.has(key) || value === undefined || typeof value === 'function') continue;
        metadata[key] = cloneSerializable(value);
    }

    return {
        ...metadata,
        organization_id,
        direction: 'credit',
        amount: normalized.amount,
        currency,
        precision: normalized.precision,
        totals: [{
            amount: normalized.amount,
            currency,
            precision: normalized.precision
        }],
        sourceAmount: {
            amount: toUnsignedBigInt(options.amount, 'amount').toString(),
            currency,
            precision: Number(options.precision ?? 0)
        },
        totalRequests: Number(options.totalRequests) || 1
    };
}

async function writeLedgerEntry(organization_id, usageObject) {
    if (!server?.crud) {
        throw new Error('server.crud is not available to save a ledger entry.');
    }

    const writes = [server.crud.send({
        method: 'object.create',
        array: 'servers_usage',
        object: usageObject,
        organization_id
    })];

    if (platformOrgId !== organization_id) {
        writes.push(server.crud.send({
            method: 'object.create',
            array: 'servers_usage',
            object: {
                ...usageObject,
                organization_id: platformOrgId,
                organization: organization_id,
                processed: false
            },
            organization_id: platformOrgId
        }));
    }

    const responses = await Promise.all(writes);
    const failedResponse = responses.find(hasResponseError);
    if (failedResponse) {
        throw new Error(`Failed to write ledger entry: ${JSON.stringify(failedResponse.error)}`);
    }
    await applyBalanceEntry(organization_id, usageObject);
    return usageObject;
}

async function applyBalanceEntry(organization_id, usageObject) {
    const totals = Array.isArray(usageObject.totals) ? usageObject.totals : [];
    if (totals.length !== 1) {
        if (totals.length > 1) {
            throw new Error('A balance entry must resolve to exactly one currency.');
        }
        return;
    }

    const total = totals[0];
    const unsignedAmount = fixedAmountToNumber(total.amount, total.precision);
    const delta = usageObject.direction === 'credit'
        ? unsignedAmount
        : -unsignedAmount;

    const update = await server.crud.send({
        method: 'object.update',
        array: 'organizations',
        object: {
            _id: organization_id,
            '$inc.balance': delta
        },
        organization_id: platformOrgId
    });

    if (hasResponseError(update)) {
        throw new Error(`Failed to update organization balance: ${JSON.stringify(update.error)}`);
    }

    const response = await server.crud.send({
        method: 'object.read',
        array: 'organizations',
        object: { _id: organization_id },
        organization_id: platformOrgId
    });
    const organization = Array.isArray(response?.object)
        ? response.object[0]
        : response?.object;

    if (!organization || !Number.isFinite(Number(organization.balance))) {
        throw new Error(`Unable to read the updated balance for organization ${organization_id}.`);
    }

    const balance = Number(organization.balance);
    const organizationBalance = balance > 0;
    const event = {
        method: 'organization.balance',
        organization_id,
        organizationBalance,
        balance,
        currency: total.currency
    };

    process.emit('organization.balance', event);
}

async function savePricedUsage(organization_id, options) {
    const usageObject = createPricedUsageObject(organization_id, options);
    return writeLedgerEntry(organization_id, usageObject);
}

async function saveCredit(organization_id, options) {
    const creditObject = createCreditObject(organization_id, options);
    return writeLedgerEntry(organization_id, creditObject);
}

function firstObject(response) {
    return Array.isArray(response?.object)
        ? response.object[0]
        : response?.object;
}

function getPaymentReference(options = {}) {
    return options.payment_intent_id ||
        options.paymentIntentId ||
        options.transaction_id ||
        options.reference?.payment_intent_id ||
        options.reference?.transaction_id;
}

async function findPaymentTransaction(organization_id, provider, paymentReference) {
    const response = await server.crud.send({
        method: 'object.read',
        array: 'transactions',
        organization_id,
        filter: {
            query: {
                provider,
                provider_payment_id: paymentReference
            },
            limit: 1
        }
    });

    if (hasResponseError(response)) {
        throw new Error(`Failed to read payment transaction: ${JSON.stringify(response.error)}`);
    }
    return firstObject(response);
}

async function updatePaymentTransaction(organization_id, transaction, update) {
    const response = await server.crud.send({
        method: 'object.update',
        array: 'transactions',
        organization_id,
        object: {
            _id: transaction._id,
            ...update
        }
    });

    if (hasResponseError(response)) {
        throw new Error(`Failed to update payment transaction: ${JSON.stringify(response.error)}`);
    }
    return { ...transaction, ...update };
}

async function createPaymentTransaction(organization_id, options, provider, paymentReference) {
    const precision = Number(options.precision ?? 2);
    const sourceAmount = toUnsignedBigInt(options.amount, 'amount').toString();
    const amount = fixedAmountToNumber(sourceAmount, precision);
    const currency = String(options.currency || 'USD').toUpperCase();
    const eventId = options.event_id || options.eventId || options.reference?.event_id;
    const now = options.date ? new Date(options.date) : new Date();

    if (Number.isNaN(now.getTime())) {
        throw new TypeError('date must be a valid date when provided.');
    }

    const response = await server.crud.send({
        method: 'object.create',
        array: 'transactions',
        organization_id,
        object: {
            type: 'credit',
            payment_type: 'usage_credit',
            provider,
            provider_event_id: eventId,
            provider_payment_id: paymentReference,
            payment_id: paymentReference,
            customer_id: options.customer_id || options.customerId,
            payment_method_id: options.payment_method_id || options.paymentMethodId,
            amount,
            provider_amount: sourceAmount,
            currency,
            precision,
            status: 'completed',
            ledger_status: 'pending',
            date: now,
            metadata: cloneSerializable(options.metadata),
            reference: paymentReference
        }
    });

    if (hasResponseError(response)) {
        throw new Error(`Failed to create payment transaction: ${JSON.stringify(response.error)}`);
    }

    const transaction = firstObject(response);
    if (!transaction?._id) {
        throw new Error('Payment transaction was created without an _id.');
    }
    return transaction;
}

/**
 * Records a successful provider payment and projects it into the usage ledger.
 * Amount is supplied in the provider's smallest currency unit. For Stripe USD,
 * `{ amount: 5000, precision: 2 }` represents $50.00.
 */
async function savePayment(organization_id, options) {
    if (!server?.crud) {
        throw new Error('server.crud is not available to record a payment.');
    }

    const provider = String(options.provider || '').trim().toLowerCase();
    if (!provider) throw new TypeError('provider is required.');

    const paymentReference = getPaymentReference(options);
    if (!paymentReference) {
        throw new TypeError('A provider payment or transaction ID is required.');
    }

    const status = String(options.status || 'succeeded').toLowerCase();
    if (!['succeeded', 'completed', 'paid'].includes(status)) {
        throw new Error(`Payment ${paymentReference} is not successful (${status}).`);
    }

    let transaction = await findPaymentTransaction(
        organization_id,
        provider,
        paymentReference
    );

    if (transaction?.ledger_status === 'applied') {
        return { transaction, duplicate: true };
    }

    if (!transaction) {
        transaction = await createPaymentTransaction(
            organization_id,
            options,
            provider,
            paymentReference
        );
    }

    try {
        const ledger = await saveCredit(organization_id, {
            organization_id,
            type: 'funds',
            provider,
            amount: options.amount,
            currency: options.currency,
            precision: options.precision ?? 2,
            idempotency_key: `${provider}:${paymentReference}`,
            reference: {
                ...(cloneSerializable(options.reference) || {}),
                provider,
                event_id: options.event_id || options.eventId || options.reference?.event_id,
                payment_intent_id: paymentReference,
                transaction_id: transaction._id
            }
        });

        transaction = await updatePaymentTransaction(
            organization_id,
            transaction,
            {
                ledger_status: 'applied',
                ledger_reference: `${provider}:${paymentReference}`,
                ledger_applied_on: new Date()
            }
        );

        return { transaction, ledger, duplicate: false };
    } catch (error) {
        await updatePaymentTransaction(
            organization_id,
            transaction,
            {
                ledger_status: 'failed',
                ledger_error: error.message
            }
        ).catch(() => undefined);
        throw error;
    }
}

function queueLedgerWrite(organization_id, writer) {
    const previous = ledgerQueues.get(organization_id) || Promise.resolve();
    const current = previous
        .catch(() => undefined)
        .then(writer);

    ledgerQueues.set(organization_id, current);
    const cleanup = () => {
        if (ledgerQueues.get(organization_id) === current) {
            ledgerQueues.delete(organization_id);
        }
    };
    current.then(cleanup, cleanup);
    return current;
}

function queuePricedUsage(organization_id, options) {
    return queueLedgerWrite(
        organization_id,
        () => savePricedUsage(organization_id, options)
    );
}

function credit(options = {}) {
    return send({ ...options, direction: 'credit' });
}

function payment(options = {}) {
    if (!options || typeof options !== 'object' || !options.organization_id) {
        throw new TypeError('organization_id is required to record a payment.');
    }

    return queueLedgerWrite(
        options.organization_id,
        () => savePayment(options.organization_id, options)
    );
}

/**
 * Public ingress wrapper for transmitting bandwidth metrics into the usage system.
 * Accepts a normalized object: { organization_id, type, data, payload, bytes, ingressBytes, egressBytes }.
 * `data` is the established event field; `payload` remains available as an alias.
 *
 * @param {Object} options - Usage transmission options
 */
function send(options = {}) {
    if (!options || typeof options !== 'object') return;

    const { organization_id, type } = options;
    if (!organization_id) return;

    if (options.direction === 'credit') {
        return queueLedgerWrite(
            organization_id,
            () => saveCredit(organization_id, options)
        );
    }

    if (
        options.usage &&
        typeof options.usage === 'object' &&
        !Array.isArray(options.usage) &&
        Array.isArray(options.pricing)
    ) {
        return queuePricedUsage(organization_id, options);
    }

    if (type === 'ai') {
        accumulateAI(options);
        return;
    }

    let ingressBytes = options.ingressBytes || 0;
    let egressBytes = options.egressBytes || 0;

    const payload = options.data !== undefined ? options.data : options.payload;
    const byteCount = options.bytes !== undefined
        ? Number(options.bytes) || 0
        : calculatePayloadBytes(payload);

    if (type === 'ingress') {
        ingressBytes += byteCount;
    } else if (type === 'egress') {
        egressBytes += byteCount;
    } else if (!type && byteCount) {
        ingressBytes += byteCount;
    }

    accumulate(organization_id, ingressBytes, egressBytes);
}

function normalizeCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? count : 0;
}

function createAIStats(provider, model, now) {
    return {
        provider,
        model,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalRequests: 0,
        sampleStart: now,
        sampleEnd: now,
        references: []
    };
}

function addAIUsage(group, provider, model, sample, reference, now) {
    const key = JSON.stringify([provider, model]);
    let stats = group.get(key);
    if (!stats) {
        stats = createAIStats(provider, model, now);
        group.set(key, stats);
    }

    for (const field of aiTokenFields) {
        stats[field] += normalizeCount(sample[field]);
    }
    stats.totalRequests += 1;
    stats.sampleEnd = now;
    if (reference && typeof reference === 'object') {
        stats.references.push({ ...reference });
    }
}

/**
 * Accumulates one actual model-call usage sample. A single AI turn may produce
 * several samples when tools or sub-agents cause additional model calls.
 */
function accumulateAI(options = {}) {
    const organization_id = options.organization_id;
    if (!organization_id) return;

    const sample = options.sample ?? options.usage ?? options.data ?? {};
    if (!sample || typeof sample !== 'object') return;

    const provider = String(options.provider ?? sample.provider ?? 'unknown');
    const model = String(options.model ?? sample.model ?? 'unknown');
    const now = Date.now();
    let groups = aiUsageMap.get(organization_id);

    if (!groups) {
        groups = {
            tenant: new Map(),
            platform: new Map(),
            timer: setInterval(() => {
                flushAIWindow(organization_id).catch(err => {
                    console.error(`${logPrefix()} Error flushing AI usage for ${organization_id}:`, err);
                });
            }, getTenantIntervalMs())
        };
        aiUsageMap.set(organization_id, groups);
    }

    addAIUsage(groups.tenant, provider, model, sample, options.reference, now);
    addAIUsage(groups.platform, provider, model, sample, options.reference, now);
}

async function flushAIGroup(organization_id, target) {
    const groups = aiUsageMap.get(organization_id);
    const group = groups?.[target];
    if (!group?.size) return;

    // Replace the live map before writes begin so new samples are never mixed
    // into an in-flight persistence operation.
    groups[target] = new Map();
    const writer = target === 'platform'
        ? saveAIToPlatformLedger
        : saveAIToTenantLedger;
    await Promise.all([...group.values()].map(stats => writer(organization_id, stats)));
}

async function flushAIWindow(organization_id) {
    await Promise.all([
        flushAIGroup(organization_id, 'tenant'),
        flushAIGroup(organization_id, 'platform')
    ]);
}

/**
 * Internal helper to accumulate bandwidth metrics into memory buffers.
 */
function accumulate(organization_id, ingressBytes = 0, egressBytes = 0) {
    if (!organization_id) return;

    const totalIncoming = ingressBytes + egressBytes;
    if (totalIncoming === 0) return;

    let stats = bandwidthMap.get(organization_id);
    const now = Date.now();

    if (!stats) {
        stats = {
            tenant: {
                ingressBytes: 0,
                egressBytes: 0,
                totalBytes: 0,
                count: 0,
                sampleStart: now,
                sampleEnd: now
            },
            platform: {
                ingressBytes: 0,
                egressBytes: 0,
                totalBytes: 0,
                count: 0,
                sampleStart: now,
                sampleEnd: now
            },
            tenantTimer: setInterval(() => {
                flushTenantWindow(organization_id).catch(err => {
                    console.error(`${logPrefix()} Error flushing tenant window for ${organization_id}:`, err);
                });
            }, getTenantIntervalMs())
        };
        bandwidthMap.set(organization_id, stats);
    }

    // 1. Accumulate Tenant Buffer (Flushes on 1-minute interval)
    stats.tenant.ingressBytes += ingressBytes;
    stats.tenant.egressBytes += egressBytes;
    stats.tenant.totalBytes += totalIncoming;
    stats.tenant.count += 1;
    stats.tenant.sampleEnd = now;

    // 2. Accumulate Platform Buffer (Flushes on 10MB threshold or eviction)
    stats.platform.ingressBytes += ingressBytes;
    stats.platform.egressBytes += egressBytes;
    stats.platform.totalBytes += totalIncoming;
    stats.platform.count += 1;
    stats.platform.sampleEnd = now;

    // 3. Platform Flush Trigger: Save to platform ledger if accumulators hit byte threshold
    const flushThreshold = getFlushThresholdBytes();
    if (stats.platform.totalBytes >= flushThreshold) {
        flushPlatformWindow(organization_id);
    }
}

/**
 * PIPELINE A: Handles the 1-minute interval flush to the tenant's servers_usage collection.
 */
async function flushTenantWindow(organization_id) {
    const stats = bandwidthMap.get(organization_id);
    if (!stats || stats.tenant.totalBytes === 0) return;

    // Snapshot and reset synchronously BEFORE async call to prevent reentrancy races
    const tenantData = stats.tenant;
    const now = Date.now();
    stats.tenant = {
        ingressBytes: 0,
        egressBytes: 0,
        totalBytes: 0,
        count: 0,
        sampleStart: now,
        sampleEnd: now
    };

    await saveToTenantBilling(organization_id, tenantData);
}

/**
 * PIPELINE B: Handles targeted platform flushes (when byte limit is reached).
 */
async function flushPlatformWindow(organization_id) {
    const stats = bandwidthMap.get(organization_id);
    if (!stats || stats.platform.totalBytes === 0) return;

    // Snapshot and reset synchronously BEFORE async call to prevent reentrancy races
    const platformData = stats.platform;
    const now = Date.now();
    stats.platform = {
        ingressBytes: 0,
        egressBytes: 0,
        totalBytes: 0,
        count: 0,
        sampleStart: now,
        sampleEnd: now
    };

    await saveToLedgerDatabase(organization_id, platformData);
}

/**
 * Target eviction: Clears timers and flushes all outstanding tenant & platform balances for an organization.
 * Called directly during org deletion or signal shedding (e.g. SIGTERM with orgId).
 *
 * @param {string} organization_id - Target organization ID
 */
async function flushOrg(organization_id) {
    const stats = bandwidthMap.get(organization_id);
    const aiStats = aiUsageMap.get(organization_id);
    const ledgerQueue = ledgerQueues.get(organization_id);
    if (!stats && !aiStats && !ledgerQueue) return;

    if (stats?.tenantTimer) {
        clearInterval(stats.tenantTimer);
    }
    if (aiStats?.timer) clearInterval(aiStats.timer);

    await save(organization_id);

    bandwidthMap.delete(organization_id);
    aiUsageMap.delete(organization_id);
}

/**
 * Forces an immediate save of in-memory usage metrics to the database.
 * If an organization_id is provided, saves only that target organization.
 * If omitted, saves all tracked organizations currently in memory.
 *
 * @param {string} [organization_id] - Optional target organization ID
 */
async function save(organization_id) {
    if (organization_id) {
        const tasks = [
            flushTenantWindow(organization_id),
            flushPlatformWindow(organization_id),
            flushAIWindow(organization_id)
        ];
        const ledgerQueue = ledgerQueues.get(organization_id);
        if (ledgerQueue) tasks.push(ledgerQueue);
        await Promise.all(tasks);
    } else {
        const tasks = [];
        for (const orgId of bandwidthMap.keys()) {
            tasks.push(flushTenantWindow(orgId));
            tasks.push(flushPlatformWindow(orgId));
        }
        for (const orgId of aiUsageMap.keys()) {
            tasks.push(flushAIWindow(orgId));
        }
        for (const ledgerQueue of ledgerQueues.values()) {
            tasks.push(ledgerQueue);
        }
        await Promise.all(tasks);
    }
}

function createAIUsageObject(organization_id, stats) {
    return {
        organization_id,
        type: 'ai',
        provider: stats.provider,
        model: stats.model,
        usage: {
            inputTokens: stats.inputTokens,
            outputTokens: stats.outputTokens,
            totalTokens: stats.inputTokens + stats.outputTokens,
            reasoningTokens: stats.reasoningTokens,
            cacheReadTokens: stats.cacheReadTokens,
            cacheWriteTokens: stats.cacheWriteTokens
        },
        totalRequests: stats.totalRequests,
        sampleStart: new Date(stats.sampleStart),
        sampleEnd: new Date(stats.sampleEnd),
        durationMs: stats.sampleEnd - stats.sampleStart,
        source: {
            event: 'assistant.usage',
            references: stats.references
        }
    };
}

async function saveAIToTenantLedger(organization_id, stats) {
    try {
        if (!server?.crud) {
            console.error(`${logPrefix()} server.crud is not available to save tenant AI usage.`);
            return;
        }
        await server.crud.send({
            method: 'object.create',
            array: 'servers_usage',
            object: createAIUsageObject(organization_id, stats),
            organization_id
        });
    } catch (error) {
        console.error(`${logPrefix()} Failed to write tenant AI usage for ${organization_id}:`, error);
    }
}

async function saveAIToPlatformLedger(organization_id, stats) {
    try {
        if (!server?.crud) {
            console.error(`${logPrefix()} server.crud is not available to save platform AI usage.`);
            return;
        }
        await server.crud.send({
            method: 'object.create',
            array: 'servers_usage',
            object: {
                ...createAIUsageObject(platformOrgId, stats),
                organization: organization_id,
                processed: false
            },
            organization_id: platformOrgId
        });
    } catch (error) {
        console.error(`${logPrefix()} Failed to write platform AI usage for ${organization_id}:`, error);
    }
}

/**
 * CRUD Adapter: Platform Bandwidth Collection (Private time-series log)
 * Writes into the platform's sandbox segment, cataloging target clients in "organization".
 */
async function saveToLedgerDatabase(organization_id, stats) {
    try {
        if (!server?.crud) {
            console.error(`${logPrefix()} server.crud is not available to save bandwidth ledger.`);
            return;
        }
        await server.crud.send({
            method: 'object.create',
            array: 'servers_bandwidth',
            object: {
                organization_id: platformOrgId,   // Master platform workspace
                organization: organization_id,       // Client tenant who generated the bandwidth
                ingressBytes: stats.ingressBytes,
                egressBytes: stats.egressBytes,
                totalBytes: stats.totalBytes,
                totalRequests: stats.count,
                sampleStart: new Date(stats.sampleStart),
                sampleEnd: new Date(stats.sampleEnd),
                durationMs: stats.sampleEnd - stats.sampleStart,
                processed: false                     // Ready for asynchronous billing calculations
            },
            organization_id: platformOrgId        // Direct routing to Platform DB partition
        });
    } catch (error) {
        console.error(`${logPrefix()} Failed to write to servers_bandwidth for ${organization_id}:`, error);
    }
}

/**
 * CRUD Adapter: Tenant Usage Collection (Their 1-Minute Dashboard Stream)
 * Writes directly to the tenant's partition under system collection "servers_usage".
 */
async function saveToTenantBilling(organization_id, stats) {
    try {
        if (!server?.crud) {
            console.error(`${logPrefix()} server.crud is not available to save tenant usage.`);
            return;
        }
        await server.crud.send({
            method: 'object.create',
            array: 'servers_usage',
            object: {
                organization_id,                     // Tenant sandbox segment route
                ingressBytes: stats.ingressBytes,
                egressBytes: stats.egressBytes,
                totalBytes: stats.totalBytes,
                totalRequests: stats.count,
                sampleStart: new Date(stats.sampleStart),
                sampleEnd: new Date(stats.sampleEnd),
                durationMs: stats.sampleEnd - stats.sampleStart
            },
            organization_id: organization_id         // Direct routing to Client DB partition
        });
    } catch (error) {
        console.error(`${logPrefix()} Failed to write to servers_usage for ${organization_id}:`, error);
    }
}

/**
 * Starts active usage tracking and binds process listeners.
 */
function start() {
    if (isRunning) return;
    isRunning = true;
    initEventListeners();
    console.log(`${logPrefix()} Usage tracking started.`);
}

/**
 * Stops usage tracking and clears active timers across all organizations.
 */
function stop() {
    if (!isRunning) return;
    isRunning = false;

    for (const [orgId, stats] of bandwidthMap.entries()) {
        if (stats.tenantTimer) {
            clearInterval(stats.tenantTimer);
        }
    }
    bandwidthMap.clear();
    for (const stats of aiUsageMap.values()) {
        if (stats.timer) clearInterval(stats.timer);
    }
    aiUsageMap.clear();
    ledgerQueues.clear();

    console.log(`${logPrefix()} Usage tracking stopped.`);
}

/**
 * Initializes the Usage Tracking service, loads configuration, and starts tracking if enabled.
 *
 * @param {Object|string} serverInstance - Core server instance or platformOrgId
 * @param {Object} [options={}] - Additional initialization parameters
 * @returns {Promise<Object>} Public usage tracking service interface
 */
async function init(serverInstance, options = {}) {
    if (serverInstance && typeof serverInstance === 'object') {
        server = serverInstance;
        platformOrgId = options.platformOrgId || serverInstance.organization_id || platformOrgId;
    } else if (typeof serverInstance === 'string') {
        platformOrgId = serverInstance;
    } else if (options.platformOrgId) {
        platformOrgId = options.platformOrgId;
    }

    await loadUsageConfig();

    const enabled = getValueFromObject(usageConfig, 'enabled') !== false &&
                    getValueFromObject(usageConfig, 'enabled') !== 'false';

    if (enabled) {
        start();
    } else {
        console.log(`${logPrefix()} Usage tracking is disabled.`);
    }

    console.log(`${logPrefix()} Module initialized (Platform Org: ${platformOrgId}).`);

    // Clean public API surface area matching @cocreate/server-telemetry style
    return {
        config: usageConfig,
        start,
        stop,
        send,
        accumulate,
        accumulateAI,
        calculatePayloadBytes,
        calculatePrice,
        credit,
        payment,
        save,
    };
}

export { calculatePayloadBytes, calculatePrice };
export default { init }
