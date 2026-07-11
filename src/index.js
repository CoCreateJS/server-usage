/********************************************************************************
 * Copyright (C) 2023 CoCreate and Contributors.
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
 *
 ********************************************************************************/

// Commercial Licensing Information:
// For commercial use of this software without the copyleft provisions of the AGPLv3,
// you must obtain a commercial license from CoCreate LLC.
// For details, visit <https://cocreate.app/licenses/> or contact us at sales@cocreate.app.

import server from '@cocreate/server';

// ==========================================
// Module-Level Sandbox State (ESM Singleton Container)
// ==========================================
const organizations = new Map();

/**
 * Normalizes input data types and calculates payload sizing in bytes.
 */
function getBytes(data) {
    if (typeof data === 'number')
        return data;
    else if (data instanceof Buffer)
        return data.byteLength || 0;
    else if (data instanceof String || typeof data === 'string')
        return Buffer.byteLength(data, 'utf8') || 0;
    else if (typeof data === 'object' && data !== null)
        return Buffer.byteLength(JSON.stringify(data), 'utf8') || 0;
    else return 0;
}

/**
 * Determines pricing tier rates based on aggregate historical usage indicators.
 */
function getRate(totalUsage = 0) {
    const tiers = [
        { limit: 1, rate: 10 },
        { limit: 10, rate: 5 },
        { limit: 100, rate: 2.5 },
        { limit: 1000, rate: 1.125 },
        { limit: 10000, rate: 0.562 },
        { limit: 100000, rate: 0.281 },
        { limit: 1000000, rate: 0.145 }
    ];

    const matchingTier = tiers.find(tier => totalUsage < tier.limit);
    return matchingTier ? matchingTier.rate : 0.12;
}

/**
 * Calculates and writes final bandwidth depletion transactions to the platform database.
 */
async function sendUsageUpdate(org, organization_id, host) {
    if (!server || !server.crud) return;
    delete org.debounce;

    org.dataTransferedOut += 250;
    org.dataTransferedOutCount++;

    const platformOrganization = server.config.organization_id;
    let organization = await server.crud.send({
        method: 'object.read',
        // host: server.config.host,
        array: 'organizations',
        object: { _id: organization_id },
        organization_id: platformOrganization
    });

    org.dataTransferedIn += getBytes(platformOrganization);
    org.dataTransferedInCount++;

    if (organization && organization.object && organization.object[0]) {
        organization = organization.object[0];
    } else return;

    if (server.wsManager && server.wsManager.organizations.has(organization_id)) {
        const socketOrg = server.wsManager.organizations.get(organization_id);
        if (organization.balance <= 0) {
            socketOrg.status = false;
            socketOrg.organizationBalance = false;
            socketOrg.error = 'Your balance has fallen below 0';
        } else {
            socketOrg.status = true;
            socketOrg.organizationBalance = true;
            socketOrg.error = '';
        }
    }

    let timeStamp = new Date(new Date().toISOString());
    let isExpired = false;
    if (organization.lastDeposit) {
        let lastDeposit = new Date(organization.lastDeposit);
        isExpired = lastDeposit <= timeStamp.setFullYear(timeStamp.getFullYear() - 1);
    }

    let isResetDataTransfer = false;
    if (organization.modified && organization.modified.on) {
        let previousTimeStamp = new Date(organization.modified.on);
        if (previousTimeStamp.getMonth() !== timeStamp.getMonth()) {
            isResetDataTransfer = true;
            server.crud.send({
                method: 'object.create',
                // host: server.config.host,
                array: 'transactions',
                object: {
                    organization_id,
                    type: "withdrawal",
                    dataTransfered: organization.dataTransfered,
                    previousTimeStamp
                },
                organization_id: platformOrganization,
                timeStamp
            });
            organization.dataTransfered = 0;
        }
    }

    let dataTransfered = org.dataTransferedIn + org.dataTransferedOut;
    dataTransfered = dataTransfered / 1073741824;
    dataTransfered = dataTransfered.toFixed(32);
    dataTransfered = parseFloat(dataTransfered);

    let rate = getRate(organization.dataTransfered);
    let amount = dataTransfered * rate;
    amount = -amount;
    amount = amount.toFixed(32);
    amount = parseFloat(amount);

    let balanceUpdate = {
        method: 'object.update',
        // host: server.config.host,
        array: 'organizations',
        object: { _id: organization_id },
        organization_id: platformOrganization,
        timeStamp
    };

    if (isExpired)
        balanceUpdate.object['balance'] = 0;
    else
        balanceUpdate.object.$inc = { balance: amount };

    if (isResetDataTransfer)
        balanceUpdate.object['dataTransfered'] = 0;
    else if (!balanceUpdate.object.$inc)
        balanceUpdate.object.$inc = { dataTransfered };
    else
        balanceUpdate.object.$inc.dataTransfered = dataTransfered;

    server.crud.send(balanceUpdate);

    let transaction = {
        method: 'object.create',
        host,
        array: 'transactions',
        object: {
            organization_id,
            type: "withdrawal",
            amount,
            rate,
            dataTransfered,
            ...org
        },
        organization_id,
        timeStamp
    };

    server.crud.send(transaction);
}

/**
 * Event-driven handler that accumulates payload footprints and manages write debouncing.
 */
async function setBandwidth({ type, data, organization_id }) {
    try {
        let dataTransfered = getBytes(data);

        if (!dataTransfered || !organization_id)
            return;

        let org = organizations.get(organization_id);
        if (!org) {
            org = {};
            org.debounce = setTimeout(() => {
                sendUsageUpdate(org, organization_id, data.host);
                organizations.delete(organization_id);
            }, 60000);

            org.dataTransferedIn = 0;
            org.dataTransferedInCount = 0;
            org.dataTransferedOut = 0;
            org.dataTransferedOutCount = 0;

            organizations.set(organization_id, org);
        }

        if (type === 'in') {
            org.dataTransferedIn = dataTransfered;
            org.dataTransferedInCount++;
        } else if (type === 'out') {
            org.dataTransferedOut = dataTransfered;
            org.dataTransferedOutCount++;
        } else {
            console.log('else');
        }

    } catch (error) {
        console.log('Usage error', error);
    }
}

/**
 * Auto-initialization loop.
 * Silently polls to verify that the unified server orchestrator is fully loaded,
 * and that both the database (crud) and socket manager (wsManager) have completed
 * their initial handshakes, then attaches active bandwidth monitoring triggers.
 */
function init() {
    if (server && server.isInitialized && server.crud && server.wsManager) {
        server.wsManager.on('setBandwidth', (data) => setBandwidth(data));
        console.log('[@cocreate/usage] Bandwidth monitoring event triggers successfully registered.');
    } else {
        // If the server and WebSocket managers are not yet ready, retry in 500ms
        setTimeout(init, 500);
    }
}

// Auto-execute initialization upon module load
init();

export default init;