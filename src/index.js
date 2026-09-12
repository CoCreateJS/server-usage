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

// Default configuration settings
const defaults = {
    enabled: true,
    flushThresholdBytes: 10 * 1024 * 1024, // 10 Megabyte flush threshold for platform ledger
    tenantIntervalMs: 60 * 1000            // 1 Minute interval for tenant usage stream
};

// Double-buffer map tracking separate platform and tenant blocks per organization
// Key: organization_id -> Value: { tenant, platform, tenantTimer }
const bandwidthMap = new Map();

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
        console.error('[@cocreate/usage] Error loading configuration:', err);
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

function initEventListeners() {
    if (listenersBound) return;
    listenersBound = true;

    process.on('usage', (options) => {
        send(options);
    });

    process.on('orgDeleted', (orgId) => {
        flushOrg(orgId).catch(err => {
            console.error(`[@cocreate/usage] Error flushing org ${orgId} on deletion:`, err);
        });
    });

    const shutdownHandler = async () => {
        try {
            await save();
        } catch (err) {
            console.error('[@cocreate/usage] Error during shutdown save:', err);
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
        console.error('[@cocreate/usage] Failed to calculate payload bytes:', error);
        return 0;
    }
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
                    console.error(`[@cocreate/usage] Error flushing tenant window for ${organization_id}:`, err);
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
    if (!stats) return;

    if (stats.tenantTimer) {
        clearInterval(stats.tenantTimer);
    }

    await save(organization_id);

    bandwidthMap.delete(organization_id);
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
        await Promise.all([
            flushTenantWindow(organization_id),
            flushPlatformWindow(organization_id)
        ]);
    } else {
        const tasks = [];
        for (const orgId of bandwidthMap.keys()) {
            tasks.push(flushTenantWindow(orgId));
            tasks.push(flushPlatformWindow(orgId));
        }
        await Promise.all(tasks);
    }
}

/**
 * CRUD Adapter: Platform Bandwidth Collection (Private time-series log)
 * Writes into the platform's sandbox segment, cataloging target clients in "organization".
 */
async function saveToLedgerDatabase(organization_id, stats) {
    try {
        if (!server?.crud) {
            console.error('[@cocreate/usage] server.crud is not available to save bandwidth ledger.');
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
        console.error(`[@cocreate/usage] Failed to write to servers_bandwidth for ${organization_id}:`, error);
    }
}

/**
 * CRUD Adapter: Tenant Usage Collection (Their 1-Minute Dashboard Stream)
 * Writes directly to the tenant's partition under system collection "servers_usage".
 */
async function saveToTenantBilling(organization_id, stats) {
    try {
        if (!server?.crud) {
            console.error('[@cocreate/usage] server.crud is not available to save tenant usage.');
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
        console.error(`[@cocreate/usage] Failed to write to servers_usage for ${organization_id}:`, error);
    }
}

/**
 * Starts active usage tracking and binds process listeners.
 */
function start() {
    if (isRunning) return;
    isRunning = true;
    initEventListeners();
    console.log(`[@cocreate/usage] Usage tracking started.`);
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

    console.log(`[@cocreate/usage] Usage tracking stopped.`);
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
        console.log('[@cocreate/usage] Usage tracking is disabled.');
    }

    console.log(`[@cocreate/usage] Module initialized (Platform Org: ${platformOrgId}).`);

    // Clean public API surface area matching @cocreate/server-telemetry style
    return {
        config: usageConfig,
        start,
        stop,
        send,
        accumulate,
        calculatePayloadBytes,
        save,
    };
}

export default { init }
