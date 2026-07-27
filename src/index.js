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
 ********************************************************************************/

import crud from '@cocreate/crud-server';

class CoCreateUsage {
    constructor(platformOrgId) {
        this.platformOrgId = platformOrgId; // Master platform organization ID

        // Constants
        this.FLUSH_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10 Megabytes
        this.TENANT_INTERVAL_MS = 60 * 1000;            // 1 Minute

        // Double-buffer map tracking separate platform and tenant blocks per organization
        this.bandwidthMap = new Map();

        // Initialize the Event Listeners
        this.initEventListeners();
    }

    /**
     * Connects directly to process event signals.
     */
    initEventListeners() {
        // Unified Application-Wide System Interceptor
        // Expects an input object: { organization_id, data, type: 'ingress' | 'egress' }
        process.on('usage', (payload) => {
            if (!payload || typeof payload !== 'object') return;
            
            const { organization_id, data, type } = payload;
            if (organization_id) {
                this.trackUsage(organization_id, data, type || 'ingress');
            }
        });

        // Dynamic Eviction Loop: Caught via native process messaging.
        // Triggers clean flushes and timer de-allocations during standard disconnects or orchestrator shutdowns.
        process.on('orgDeleted', async (organization_id) => {
            if (this.bandwidthMap.has(organization_id)) {
                console.log(`[USAGE] Event Received: Flushing pending data pipelines for Org: ${organization_id}`);
                try {
                    await this.flushAndClearSingle(organization_id);
                    console.log(`[USAGE] Flushing Completed: Memory registry successfully cleared for Org: ${organization_id}`);
                } catch (err) {
                    console.error(`[USAGE ERROR] Failed to cleanly flush data during orgDeleted event for ${organization_id}:`, err);
                }
            }
        });
    }

    /**
     * High-performance, robust byte-calculation routine.
     * Accurately parses binary files (images, video chunks), text responses, and data objects.
     */
    calculatePayloadBytes(data) {
        if (data === null || data === undefined) return 0;
        
        try {
            // Case 1: Raw media streams, files, or binary chunks (Buffers / TypedArrays)
            if (Buffer.isBuffer(data)) {
                return data.length;
            }
            if (data instanceof Uint8Array || data.buffer instanceof ArrayBuffer) {
                return data.byteLength || data.length || 0;
            }
            
            // Case 2: Plain Text / Base64 Encoded Strings
            if (typeof data === 'string') {
                return Buffer.byteLength(data, 'utf8');
            }
            
            // Case 3: Native JavaScript Objects & Arrays (Database schemas, API JSON packets)
            if (typeof data === 'object') {
                return Buffer.byteLength(JSON.stringify(data), 'utf8');
            }
            
            // Case 4: Fallback for primitive datatypes (numbers, booleans, etc.)
            return Buffer.byteLength(String(data), 'utf8');
        } catch (error) {
            console.error('[USAGE ERROR] Failed to safely calculate payload byte scale:', error);
            return 0;
        }
    }

    /**
     * Main entry point to track incoming traffic.
     */
    trackUsage(organization_id, data, direction = 'ingress') {
        const now = Date.now();
        const incomingBytes = this.calculatePayloadBytes(data);

        // If this is a brand new organization session, initialize our distinct tracking layers
        if (!this.bandwidthMap.has(organization_id)) {
            const tenantTimer = setInterval(() => {
                this.flushTenantWindow(organization_id);
            }, this.TENANT_INTERVAL_MS);

            this.bandwidthMap.set(organization_id, {
                // Buffer A: Tenant 1-minute accumulator (server_usage)
                tenant: {
                    ingressBytes: 0,
                    egressBytes: 0,
                    totalBytes: 0,
                    count: 0,
                    sampleStart: now,
                    sampleEnd: now
                },
                // Buffer B: Platform master accumulator (server_bandwidth)
                platform: {
                    ingressBytes: 0,
                    egressBytes: 0,
                    totalBytes: 0,
                    count: 0,
                    sampleStart: now,
                    sampleEnd: now
                },
                tenantTimer
            });
        }

        const stats = this.bandwidthMap.get(organization_id);

        // 1. Accumulate Tenant Buffer (Flushes on interval)
        if (direction === 'ingress') {
            stats.tenant.ingressBytes += incomingBytes;
        } else if (direction === 'egress') {
            stats.tenant.egressBytes += incomingBytes;
        }
        stats.tenant.totalBytes += incomingBytes;
        stats.tenant.count += 1;
        stats.tenant.sampleEnd = now;

        // 2. Accumulate Platform Buffer (Flushes on event triggers / 10MB only)
        if (direction === 'ingress') {
            stats.platform.ingressBytes += incomingBytes;
        } else if (direction === 'egress') {
            stats.platform.egressBytes += incomingBytes;
        }
        stats.platform.totalBytes += incomingBytes;
        stats.platform.count += 1;
        stats.platform.sampleEnd = now;

        // 3. Platform Trigger: Flush to the master platform ledger if we hit 10MB
        if (stats.platform.totalBytes >= this.FLUSH_THRESHOLD_BYTES) {
            this.flushPlatformWindow(organization_id);
        }
    }

    /**
     * PIPELINE A: Handles the 1-minute interval flush to the client tenant's database
     */
    async flushTenantWindow(organization_id) {
        const stats = this.bandwidthMap.get(organization_id);
        if (!stats || stats.tenant.totalBytes === 0) return;

        const tenantData = stats.tenant;

        // Save exactly one document representing this complete 1-minute segment to their partition
        await this.saveToTenantBilling(organization_id, tenantData);

        // Reset ONLY the tenant accumulator to begin a fresh 1-minute block
        const now = Date.now();
        stats.tenant = {
            ingressBytes: 0,
            egressBytes: 0,
            totalBytes: 0,
            count: 0,
            sampleStart: now,
            sampleEnd: now
        };
    }

    /**
     * PIPELINE B: Handles targeted platform flushes (when 10MB limit is reached)
     */
    async flushPlatformWindow(organization_id) {
        const stats = this.bandwidthMap.get(organization_id);
        if (!stats || stats.platform.totalBytes === 0) return;

        const platformData = stats.platform;

        // Save platform ledger record
        await this.saveToLedgerDatabase(organization_id, platformData);

        // Reset ONLY the platform long-term memory accumulator
        const now = Date.now();
        stats.platform = {
            ingressBytes: 0,
            egressBytes: 0,
            totalBytes: 0,
            count: 0,
            sampleStart: now,
            sampleEnd: now
        };
    }

    /**
     * Target eviction: Clears timers and flushes all outstanding tenant & platform balances
     */
    async flushAndClearSingle(organization_id) {
        const stats = this.bandwidthMap.get(organization_id);
        if (!stats) return;

        // De-allocate the 1-minute background loop instantly
        if (stats.tenantTimer) {
            clearInterval(stats.tenantTimer);
        }

        // Flush any partial unsaved records remaining in either pipeline
        await Promise.all([
            this.flushTenantWindow(organization_id),
            this.flushPlatformWindow(organization_id)
        ]);

        // Evict from active tracker
        this.bandwidthMap.delete(organization_id);
    }

    /**
     * CRUD Adapter: Platform Bandwidth Collection (Private time-series log)
     * Writes into the platform's sandbox segment, cataloging target clients in "organization".
     */
    async saveToLedgerDatabase(organization_id, stats) {
        try {
            await crud.send({
                method: 'object.create',
                array: 'servers_bandwidth',
                object: {
                    organization_id: this.platformOrgId, // Platform workspace sandbox route
                    organization: organization_id,       // The actual client tenant who generated the bandwidth
                    ingressBytes: stats.ingressBytes,
                    egressBytes: stats.egressBytes,
                    totalBytes: stats.totalBytes,
                    totalRequests: stats.count,
                    sampleStart: new Date(stats.sampleStart),
                    sampleEnd: new Date(stats.sampleEnd),
                    durationMs: stats.sampleEnd - stats.sampleStart,
                    processed: false                     // Ready for asynchronous billing calculations
                },
                organization_id: this.platformOrgId      // Outermost routing targeting the Platform's DB partition
            });
        } catch (error) {
            console.error(`[DB ERROR] Failed to write to servers_bandwidth for ${organization_id}:`, error);
        }
    }

    /**
     * CRUD Adapter: Tenant Usage Collection (Their 1-Minute Dashboard Stream)
     * Writes directly to the tenant's partition under the safe, system namespace "servers_usage"
     */
    async saveToTenantBilling(organization_id, stats) {
        try {
            await crud.send({
                method: 'object.create',
                array: 'servers_usage',
                object: {
                    organization_id,                     // Tenant's sandbox segment route
                    ingressBytes: stats.ingressBytes,
                    egressBytes: stats.egressBytes,
                    totalBytes: stats.totalBytes,
                    totalRequests: stats.count,
                    sampleStart: new Date(stats.sampleStart),
                    sampleEnd: new Date(stats.sampleEnd),
                    durationMs: stats.sampleEnd - stats.sampleStart
                },
                organization_id: organization_id         // Outermost routing targeting the Client's DB partition
            });
        } catch (error) {
            console.error(`[DB ERROR] Failed to write to servers_usage for ${organization_id}:`, error);
        }
    }
}

export default CoCreateUsage;