# CoCreate Server Usage

CoCreate Server Usage is the server-side usage metering and billing ledger for CoCreate. It records priced consumption, credits and payment events, maintains organization balance projections, and emits balance-gating events for the server cluster.

![GitHub latest release](https://img.shields.io/github/v/release/CoCreateJS/usage?style=flat-square)
![GitHub contributors](https://img.shields.io/github/contributors/CoCreateJS/usage?style=flat-square)
![License](https://img.shields.io/static/v1?style=flat-square&label=license&message=AGPL-3.0&color=green)
![Hiring](https://img.shields.io/static/v1?style=flat-square&label=&message=Hiring&color=blueviolet)

![CoCreate](https://cdn.CoCreateJS.com/logo.png)

[CoCreate Server Usage Docs](https://CoCreateJS.com/docs/usage)

## Usage events

CoCreate Usage listens for process-level `usage` events. Any producer can send
a resolved `usage` and `pricing` contract; Usage calculates the charge with
fixed-point integer arithmetic and immediately writes an entry to the tenant
and platform `servers_usage` ledgers. The `type` identifies the service but
does not change the pricing algorithm:

```js
process.emit('usage', {
    type: 'ai',
    organization_id: 'organization-id',
    provider: 'openai',
    model: 'gpt-5',
    usage: {
        input_tokens: 120,
        output_tokens: 40,
        reasoning_tokens: 10,
        cache_read_tokens: 80,
        cache_write_tokens: 0
    },
    pricing: [
        {
            meter: 'input_tokens',
            model: 'gpt-5',
            unit: 1000000,
            amount: 1250000,
            currency: 'USD',
            precision: 6
        },
        {
            meter: 'output_tokens',
            model: 'gpt-5',
            unit: 1000000,
            amount: 10000000,
            currency: 'USD',
            precision: 6
        }
    ],
    reference: {
        request_id: 'provider-request-id',
        conversation_id: 'conversation-id'
    }
});
```

The producer resolves the applicable pricing entries before sending the event.
Usage matches each `pricing[].meter` to `usage[meter]` and stores the original
usage, applied pricing snapshot, individual charges, and currency totals. Charge
amounts are integer strings at `precision: 12` by default, making calculations
deterministic without JavaScript floating-point currency arithmetic. When an
entry contains one currency, its total is also exposed as top-level `amount`,
`currency`, and `precision` fields.

Priced consumption is stored with `direction: "debit"`. Incoming funds,
refunds, and promotional credits use the same immutable `servers_usage`
ledger with `direction: "credit"`; amounts remain positive and direction
determines their effect on the balance:

```js
process.emit('usage', {
    type: 'funds',
    direction: 'credit',
    organization_id: 'organization-id',
    amount: 2500000,
    currency: 'USD',
    precision: 6,
    reference: {
        provider: 'stripe',
        transaction_id: 'payment-transaction-id'
    }
});
```

The equivalent low-level JavaScript API is `usage.credit(options)`. Ledger
corrections should be represented by compensating credit or debit entries
rather than modifying historical entries.

Successful payment-provider notifications should use `usage.payment(options)`.
This first stores a normalized payment in `transactions`, then creates the
credit entry in `servers_usage`, increments `organizations.balance`, and marks
the transaction's `ledger_status` as `applied`. Repeated notifications for an
already-applied provider payment return the existing transaction without
crediting it again:

```js
await usage.payment({
    organization_id: 'organization-id',
    provider: 'stripe',
    event_id: 'evt_provider-event-id',
    payment_intent_id: 'pi_provider-payment-id',
    amount: 5000,
    currency: 'USD',
    precision: 2,
    status: 'succeeded',
    customer_id: 'cus_provider-customer-id',
    payment_method_id: 'pm_provider-payment-method-id'
});
```

The amount uses the provider's integer minor unit: Stripe `5000` with
`precision: 2` is stored as a `$50.00` transaction and credited as `$50.00`.
Only verified server-side webhooks should call this method; browser success
callbacks are not authoritative payment confirmation.

After recording an entry, Usage atomically increments the materialized
`organizations.balance` projection through CRUD. A balance at or below zero
emits `organization.balance` with `organizationBalance: false`; a later credit
that restores a positive balance emits `organizationBalance: true`. The local
Socket Server consumes this event, distributes `organization.evicted` when the
balance is depleted, and drains the organization from receiving workers. The
immutable ledger remains the source of truth if the materialized balance ever
needs to be reconciled.

Unpriced bandwidth events continue to accept `type: "ingress"` and
`type: "egress"` and use the existing aggregation pipeline. Legacy unpriced AI
events continue through the interval-based AI aggregation path during the
transition to resolved pricing.

We want this library to be community-driven, and CoCreate led. We need your help to realize this goal. To help make sure we are building the right things in the right order, we ask that you create [issues](https://github.com/CoCreateJS/Realtime_Admin_CRM_and_CMS/issues) and [pull requests](https://github.com/CoCreateJS/Realtime_Admin_CRM_and_CMS/pulls) or merely upvote or comment on existing issues or pull requests.

We appreciate your continued support, thank you!

# Table of Contents

-   [Table of Contents](#table-of-contents)
-   [Announcements](#announcements)
-   [Roadmap](#roadmap)
-   [How to Contribute](#how-to-contribute)
-   [About](#about)
-   [License](#license)

<a name="announcements"></a>

# Announcements

All updates to this library are documented in our [CHANGELOG](https://github.com/CoCreateJS/usage/blob/master/CHANGELOG.md) and [releases](https://github.com/CoCreateJS/usage/releases). You may also subscribe to email for releases and breaking changes.

<a name="roadmap"></a>

# Roadmap

If you are interested in the future direction of this project, please take a look at our open [issues](https://github.com/CoCreateJS/usage/issues) and [pull requests](https://github.com/CoCreateJS/usage/pulls). We would love to hear your feedback.

<a name="about"></a>

# About

CoCreate Server Usage is guided and supported by the CoCreate Developer Experience Team.

Please Email the Developer Experience Team [here](mailto:develop@CoCreateJS.com) in case of any queries.

CoCreate Server Usage is maintained and funded by CoCreate. The names and logos for CoCreate are trademarks of CoCreate, LLC.

<a name="contribute"></a>

# How to Contribute

We encourage contribution to our libraries (you might even score some nifty swag), please see our [CONTRIBUTING](https://github.com/CoCreateJS/usage/blob/master/CONTRIBUTING.md) guide for details.

<a name="license"></a>

# License

This software is dual-licensed under the GNU Affero General Public License version 3 (AGPLv3) and a commercial license.

-   **Open Source Use**: For open-source projects and non-commercial use, this software is available under the AGPLv3. The AGPLv3 allows you to freely use, modify, and distribute this software, provided that all modifications and derivative works are also licensed under the AGPLv3. For the full license text, see the [LICENSE file](https://github.com/CoCreateJS/usage/blob/master/LICENSE).

-   **Commercial Use**: For-profit companies and individuals intending to use this software for commercial purposes must obtain a commercial license. The commercial license is available when you sign up for an API key on our [website](https://CoCreateJS.com). This license permits proprietary use and modification of the software without the copyleft requirements of the AGPLv3. It is ideal for integrating this software into proprietary commercial products and applications.

If you have not purchased a commercial license and intend to use this software for commercial purposes, you are required to sign up for an API key on our website.
