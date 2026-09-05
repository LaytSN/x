'use strict';

/* TizenBrew runs this file in a VM with require/module/tizen, but no __dirname. */
var fs = require('fs');
var http = require('http');
var path = require('path');
var url = require('url');

var SERVICE_NAME = 'vkplay-tv-report-relay';
var VERSION = '0.1.17';
var ALLOWED_ORIGIN = 'https://cloud.vkplay.ru';
var REPORT_SCHEMA = 'vkplay-tizen-live/1';
var MAX_BODY_BYTES = 1024 * 1024;
var MAX_ACK_BYTES = 64 * 1024;
var MAX_QUEUE = 12;
var MAX_DELIVERED = 48;

function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function safeId(value) {
    return typeof value === 'string' &&
        value.length >= 1 && value.length <= 128 &&
        /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

function safeFilename(value) {
    return typeof value === 'string' &&
        value.length >= 1 && value.length <= 255 &&
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function safeErrorCode(value) {
    return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value);
}

function positiveNumber(value, fallback) {
    return typeof value === 'number' && isFinite(value) && value > 0 ? value : fallback;
}

function makeBuffer(value, encoding) {
    if (Buffer.from) return Buffer.from(value, encoding);
    return new Buffer(value, encoding);
}

function loopbackHost(host) {
    return host === '127.0.0.1';
}

function defaultState() {
    return {
        format: 1,
        queue: [],
        delivered: {},
        deliveredOrder: [],
        droppedReports: 0,
        lastDelivery: null,
        lastError: null
    };
}

function normalizeState(candidate) {
    var state = defaultState();
    var index;
    var item;
    var deliveredItem;
    if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.queue)) {
        throw new Error('invalid state');
    }
    for (index = 0; index < candidate.queue.length; index += 1) {
        item = candidate.queue[index];
        if (!item || typeof item !== 'object' || !safeId(item.reportId) ||
                !item.report || typeof item.report !== 'object' ||
                item.report.reportId !== item.reportId ||
                item.report.schema !== REPORT_SCHEMA || !safeId(item.report.runId)) {
            throw new Error('invalid queue entry');
        }
        state.queue.push({
            reportId: item.reportId,
            report: item.report,
            attempts: typeof item.attempts === 'number' && item.attempts >= 0 ? item.attempts : 0,
            nextAttemptAt: 0,
            receivedAt: typeof item.receivedAt === 'number' ? item.receivedAt : Date.now()
        });
    }
    if (state.queue.length > MAX_QUEUE) {
        state.droppedReports += state.queue.length - MAX_QUEUE;
        state.queue = state.queue.slice(state.queue.length - MAX_QUEUE);
    }
    if (candidate.delivered && typeof candidate.delivered === 'object' &&
            Array.isArray(candidate.deliveredOrder)) {
        for (index = 0; index < candidate.deliveredOrder.length; index += 1) {
            item = candidate.deliveredOrder[index];
            deliveredItem = candidate.delivered[item];
            if (safeId(item) && deliveredItem && safeFilename(deliveredItem.filename)) {
                state.delivered[item] = {
                    filename: deliveredItem.filename,
                    deliveredAt: typeof deliveredItem.deliveredAt === 'number' ?
                        deliveredItem.deliveredAt : Date.now()
                };
                state.deliveredOrder.push(item);
            }
        }
    }
    while (state.deliveredOrder.length > MAX_DELIVERED) {
        item = state.deliveredOrder.shift();
        delete state.delivered[item];
    }
    state.droppedReports += typeof candidate.droppedReports === 'number' &&
        candidate.droppedReports >= 0 ? candidate.droppedReports : 0;
    if (candidate.lastDelivery && typeof candidate.lastDelivery === 'object' &&
            safeId(candidate.lastDelivery.reportId) &&
            (candidate.lastDelivery.delivery === 'delivered' || candidate.lastDelivery.delivery === 'queued')) {
        state.lastDelivery = {
            reportId: candidate.lastDelivery.reportId,
            delivery: candidate.lastDelivery.delivery,
            at: typeof candidate.lastDelivery.at === 'number' ? candidate.lastDelivery.at : Date.now()
        };
        if (safeErrorCode(candidate.lastDelivery.upstreamFailure)) {
            state.lastDelivery.upstreamFailure = candidate.lastDelivery.upstreamFailure;
        }
        if (safeFilename(candidate.lastDelivery.filename)) {
            state.lastDelivery.filename = candidate.lastDelivery.filename;
        }
        if (candidate.lastDelivery.persistence === 'failed') {
            state.lastDelivery.persistence = 'failed';
        }
    }
    if (safeErrorCode(candidate.lastError)) {
        state.lastError = candidate.lastError;
    }
    return state;
}

function createRelay(options) {
    options = options || {};
    var host = options.host || '127.0.0.1';
    var port = options.port === 0 ? 0 : positiveNumber(options.port, 8788);
    var receiverUrl = options.receiverUrl || 'http://192.168.0.219:8787/report';
    var storageDir = options.storageDir || '/home/owner/share/vkplay-tv-reports';
    var retryBaseMs = positiveNumber(options.retryBaseMs, 5000);
    var retryMaxMs = positiveNumber(options.retryMaxMs, 60000);
    var requestTimeoutMs = positiveNumber(options.requestTimeoutMs, 5000);
    var statePath = path.join(storageDir, 'relay-state.json');
    var tempPath = path.join(storageDir, 'relay-state.json.tmp');
    var receiver = url.parse(receiverUrl);
    var state = defaultState();
    var storage = 'ok';
    var retryTimer = null;
    var activeRequest = null;
    var activeReportId = null;
    var forwarding = false;
    var closed = false;
    var persistenceBusy = false;
    var persistenceQueue = [];
    var closeCallbacks = [];
    var serverClosed = false;
    var server;

    if (!loopbackHost(host)) {
        throw new Error('relay host must be 127.0.0.1');
    }
    if (options.receiverUrl && receiver.hostname !== '127.0.0.1' && receiver.hostname !== 'localhost') {
        throw new Error('test receiver must be loopback');
    }
    if (receiver.protocol !== 'http:' || !receiver.hostname || !receiver.port || receiver.path !== '/report') {
        throw new Error('invalid receiver URL');
    }

    function ensureStorage() {
        try {
            if (fs.existsSync(storageDir)) {
                if (!fs.statSync(storageDir).isDirectory()) {
                    throw new Error('not a directory');
                }
            } else {
                fs.mkdirSync(storageDir, 493);
            }
            return true;
        } catch (error) {
            storage = 'degraded';
            state.lastError = 'storage_init';
            return false;
        }
    }

    function persistInitial() {
        if (!ensureStorage()) {
            return false;
        }
        try {
            fs.writeFileSync(tempPath, JSON.stringify(state), {encoding: 'utf8', mode: 384});
            fs.renameSync(tempPath, statePath);
            storage = 'ok';
            return true;
        } catch (error) {
            storage = 'degraded';
            state.lastError = 'storage_write';
            try { fs.unlinkSync(tempPath); } catch (ignore) {}
            return false;
        }
    }

    function finishCloseIfReady() {
        var callbacks;
        var index;
        if (!closed || !serverClosed || persistenceBusy || persistenceQueue.length > 0) return;
        callbacks = closeCallbacks;
        closeCallbacks = [];
        for (index = 0; index < callbacks.length; index += 1) callbacks[index]();
    }

    function drainPersistence() {
        var item;
        function complete(ok) {
            persistenceBusy = false;
            if (item.callback) item.callback(ok);
            drainPersistence();
            finishCloseIfReady();
        }
        if (persistenceBusy || persistenceQueue.length === 0) {
            finishCloseIfReady();
            return;
        }
        item = persistenceQueue.shift();
        persistenceBusy = true;
        fs.writeFile(tempPath, item.data, {encoding: 'utf8', mode: 384}, function (writeError) {
            if (writeError) {
                storage = 'degraded';
                state.lastError = 'storage_write';
                complete(false);
                return;
            }
            fs.rename(tempPath, statePath, function (renameError) {
                if (renameError) {
                    storage = 'degraded';
                    state.lastError = 'storage_write';
                    fs.unlink(tempPath, function () { complete(false); });
                    return;
                }
                storage = 'ok';
                complete(true);
            });
        });
    }

    function persist(callback) {
        if (!ensureStorage()) {
            if (callback) process.nextTick(function () { callback(false); });
            return;
        }
        persistenceQueue.push({data: JSON.stringify(state), callback: callback});
        drainPersistence();
    }

    function load() {
        if (!ensureStorage()) {
            return;
        }
        if (!fs.existsSync(statePath)) {
            persistInitial();
            return;
        }
        try {
            state = normalizeState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
        } catch (error) {
            state = defaultState();
            state.lastError = 'storage_load';
            persistInitial();
        }
    }

    function corsHeaders() {
        return {
            'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Allow-Private-Network': 'true',
            'Vary': 'Origin'
        };
    }

    function sendJson(response, statusCode, body, cors) {
        var headers = {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        };
        var corsValues;
        var key;
        if (cors) {
            corsValues = corsHeaders();
            for (key in corsValues) {
                if (own(corsValues, key)) headers[key] = corsValues[key];
            }
        }
        response.writeHead(statusCode, headers);
        response.end(JSON.stringify(body));
    }

    function validHost(request) {
        var actual = server.address();
        return !!actual && request.headers.host === '127.0.0.1:' + actual.port;
    }

    function findQueued(reportId) {
        var index;
        for (index = 0; index < state.queue.length; index += 1) {
            if (state.queue[index].reportId === reportId) return state.queue[index];
        }
        return null;
    }

    function removeQueued(reportId) {
        var index;
        for (index = 0; index < state.queue.length; index += 1) {
            if (state.queue[index].reportId === reportId) {
                state.queue.splice(index, 1);
                return;
            }
        }
    }

    function rememberDelivered(reportId, filename) {
        var oldId;
        if (!own(state.delivered, reportId)) state.deliveredOrder.push(reportId);
        state.delivered[reportId] = {filename: filename, deliveredAt: Date.now()};
        while (state.deliveredOrder.length > MAX_DELIVERED) {
            oldId = state.deliveredOrder.shift();
            delete state.delivered[oldId];
        }
    }

    function retryDelay(attempts) {
        var delay = retryBaseMs * Math.pow(2, Math.max(0, attempts - 1));
        return Math.min(delay, retryMaxMs);
    }

    function publicLastDelivery() {
        var result;
        if (!state.lastDelivery) return null;
        result = {
            reportId: state.lastDelivery.reportId,
            delivery: state.lastDelivery.delivery,
            upstreamFailure: state.lastDelivery.upstreamFailure || null,
            at: state.lastDelivery.at
        };
        if (state.lastDelivery.persistence === 'failed') result.persistence = 'failed';
        return result;
    }

    function scheduleRetry() {
        var wait;
        if (closed || forwarding || retryTimer || state.queue.length === 0 || storage !== 'ok') return;
        wait = Math.max(0, state.queue[0].nextAttemptAt - Date.now());
        retryTimer = setTimeout(function () {
            retryTimer = null;
            processQueue(null);
        }, wait);
        if (retryTimer.unref) retryTimer.unref();
    }

    function forward(entry, callback) {
        var payload = makeBuffer(JSON.stringify(entry.report), 'utf8');
        var finished = false;
        var deadlineTimer = null;
        var request;

        function finish(errorCode, filename) {
            if (finished) return;
            finished = true;
            if (deadlineTimer) {
                clearTimeout(deadlineTimer);
                deadlineTimer = null;
            }
            activeRequest = null;
            callback(errorCode, filename);
        }

        request = http.request({
            protocol: 'http:',
            hostname: receiver.hostname,
            port: Number(receiver.port),
            method: 'POST',
            path: '/report',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': payload.length,
                'Connection': 'close'
            },
            agent: false
        }, function (response) {
            var chunks = [];
            var size = 0;
            response.on('data', function (chunk) {
                size += chunk.length;
                if (size <= MAX_ACK_BYTES) chunks.push(chunk);
            });
            response.on('end', function () {
                var ack;
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    finish('http_' + response.statusCode);
                    return;
                }
                if (size > MAX_ACK_BYTES) {
                    finish('invalid_ack');
                    return;
                }
                try {
                    ack = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                } catch (error) {
                    finish('invalid_ack');
                    return;
                }
                if (!ack || ack.ok !== true || !safeFilename(ack.filename)) {
                    finish('invalid_ack');
                    return;
                }
                finish(null, ack.filename);
            });
            response.on('error', function () { finish('receiver_error'); });
        });
        activeRequest = request;
        deadlineTimer = setTimeout(function () {
            finish('timeout');
            request.abort();
        }, requestTimeoutMs);
        if (deadlineTimer.unref) deadlineTimer.unref();
        request.on('error', function () { finish('network_error'); });
        request.write(payload);
        request.end();
    }

    function processQueue(preferredId, callback) {
        var entry;
        if (closed || forwarding || storage !== 'ok' || state.queue.length === 0) {
            if (callback) callback('busy');
            return;
        }
        entry = state.queue[0];
        if (preferredId && entry.reportId !== preferredId) {
            if (callback) callback('busy');
            scheduleRetry();
            return;
        }
        if (!preferredId && entry.nextAttemptAt > Date.now()) {
            scheduleRetry();
            return;
        }
        forwarding = true;
        activeReportId = entry.reportId;
        forward(entry, function (errorCode, filename) {
            forwarding = false;
            if (closed) {
                activeReportId = null;
                if (callback) callback(errorCode || 'closed');
                return;
            }
            if (!errorCode) {
                removeQueued(entry.reportId);
                activeReportId = null;
                rememberDelivered(entry.reportId, filename);
                state.lastDelivery = {
                    reportId: entry.reportId,
                    delivery: 'delivered',
                    filename: filename,
                    at: Date.now()
                };
                state.lastError = null;
                persist(function (persisted) {
                    if (!persisted) {
                        state.lastDelivery.persistence = 'failed';
                        state.lastError = 'delivery_state_persist';
                    }
                    if (callback) callback(null, filename, persisted);
                    scheduleRetry();
                });
            } else {
                entry.attempts += 1;
                entry.nextAttemptAt = Date.now() + retryDelay(entry.attempts);
                state.lastDelivery = {
                    reportId: entry.reportId,
                    delivery: 'queued',
                    upstreamFailure: errorCode,
                    at: Date.now()
                };
                state.lastError = errorCode;
                persist(function () {
                    activeReportId = null;
                    if (callback) callback(errorCode);
                    scheduleRetry();
                });
            }
        });
    }

    function validReport(report) {
        return report && typeof report === 'object' && !Array.isArray(report) &&
            report.schema === REPORT_SCHEMA && safeId(report.reportId) &&
            safeId(report.runId) && typeof report.version === 'string' &&
            report.version.length >= 1 && report.version.length <= 32;
    }

    function handleReport(request, response) {
        var chunks = [];
        var size = 0;
        var answered = false;
        var declaredLength = Number(request.headers['content-length']);

        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
            sendJson(response, 415, {ok: false, error: 'content_type_required'}, true);
            request.resume();
            return;
        }
        if (isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
            sendJson(response, 413, {ok: false, error: 'body_too_large'}, true);
            request.resume();
            return;
        }
        request.on('data', function (chunk) {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                if (!answered) {
                    answered = true;
                    sendJson(response, 413, {ok: false, error: 'body_too_large'}, true);
                }
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', function () {
            var report;
            var existing;
            var entry;
            var deliveredBody;
            if (answered) return;
            try {
                report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch (error) {
                sendJson(response, 400, {ok: false, error: 'invalid_json'}, true);
                return;
            }
            if (!validReport(report)) {
                sendJson(response, 422, {ok: false, error: 'invalid_report'}, true);
                return;
            }
            if (own(state.delivered, report.reportId)) {
                deliveredBody = {
                    ok: true,
                    reportId: report.reportId,
                    delivery: 'delivered',
                    filename: state.delivered[report.reportId].filename
                };
                if (state.lastDelivery && state.lastDelivery.reportId === report.reportId &&
                        state.lastDelivery.persistence === 'failed') {
                    deliveredBody.storage = 'degraded';
                    deliveredBody.persistence = 'failed';
                }
                sendJson(response, 200, deliveredBody, true);
                return;
            }
            existing = findQueued(report.reportId);
            if (existing) {
                persist(function (persisted) {
                    if (!persisted) {
                        sendJson(response, 507, {
                            ok: false,
                            error: 'storage_unavailable',
                            reportId: report.reportId,
                            delivery: 'failed',
                            storage: 'degraded'
                        }, true);
                        return;
                    }
                    sendJson(response, 202, {
                        ok: true,
                        reportId: report.reportId,
                        delivery: 'queued',
                        storage: storage,
                        upstreamFailure: state.lastDelivery && state.lastDelivery.reportId === report.reportId ?
                            state.lastDelivery.upstreamFailure || 'pending' : 'pending'
                    }, true);
                    scheduleRetry();
                });
                return;
            }
            entry = {
                reportId: report.reportId,
                report: report,
                attempts: 0,
                nextAttemptAt: 0,
                receivedAt: Date.now()
            };
            if (state.queue.length >= MAX_QUEUE && activeReportId &&
                    state.queue[0] && state.queue[0].reportId === activeReportId) {
                state.droppedReports += 1;
                persist(function () {
                    sendJson(response, 503, {
                        ok: false,
                        error: 'queue_full',
                        reportId: report.reportId,
                        delivery: 'failed',
                        storage: storage,
                        droppedReports: state.droppedReports
                    }, true);
                });
                return;
            }
            state.queue.push(entry);
            if (state.queue.length > MAX_QUEUE) {
                state.queue.shift();
                state.droppedReports += 1;
            }
            persist(function (persisted) {
                if (!persisted) {
                    sendJson(response, 507, {
                        ok: false,
                        error: 'storage_unavailable',
                        reportId: report.reportId,
                        delivery: 'failed',
                        storage: 'degraded'
                    }, true);
                    return;
                }
                processQueue(report.reportId, function (errorCode, filename, deliveryPersisted) {
                    if (!errorCode) {
                        deliveredBody = {
                            ok: true,
                            reportId: report.reportId,
                            delivery: 'delivered',
                            filename: filename
                        };
                        if (deliveryPersisted === false) {
                            deliveredBody.storage = 'degraded';
                            deliveredBody.persistence = 'failed';
                        }
                        sendJson(response, 200, deliveredBody, true);
                        return;
                    }
                    sendJson(response, 202, {
                        ok: true,
                        reportId: report.reportId,
                        delivery: 'queued',
                        storage: storage,
                        upstreamFailure: errorCode
                    }, true);
                });
            });
        });
    }

    function handle(request, response) {
        var parsed;
        var reportId;
        var status;
        if (request.headers.origin !== ALLOWED_ORIGIN || !validHost(request)) {
            sendJson(response, 403, {ok: false, error: 'forbidden'}, false);
            request.resume();
            return;
        }
        parsed = url.parse(request.url, true);
        if (request.method === 'OPTIONS' && !parsed.search &&
                (parsed.pathname === '/report' || parsed.pathname === '/health' || parsed.pathname === '/status')) {
            response.writeHead(204, corsHeaders());
            response.end();
            return;
        }
        if (request.method === 'GET' && parsed.pathname === '/health' && !parsed.search) {
            sendJson(response, 200, {
                ok: true,
                service: SERVICE_NAME,
                version: VERSION,
                queue: state.queue.length,
                storage: storage,
                lastDelivery: publicLastDelivery(),
                lastError: state.lastError,
                droppedReports: state.droppedReports
            }, true);
            return;
        }
        if (request.method === 'GET' && parsed.pathname === '/status' &&
                parsed.search && Object.keys(parsed.query).length === 1 && own(parsed.query, 'reportId')) {
            reportId = parsed.query.reportId;
            if (!safeId(reportId)) {
                sendJson(response, 400, {ok: false, reportId: typeof reportId === 'string' ? reportId : null, error: 'invalid_report_id'}, true);
                return;
            }
            if (own(state.delivered, reportId)) {
                status = {ok: true, reportId: reportId, delivery: 'delivered', filename: state.delivered[reportId].filename};
                if (state.lastDelivery && state.lastDelivery.reportId === reportId &&
                        state.lastDelivery.persistence === 'failed') {
                    status.storage = 'degraded';
                    status.persistence = 'failed';
                }
            } else if (findQueued(reportId)) {
                status = {ok: true, reportId: reportId, delivery: 'queued'};
            } else {
                status = {ok: true, reportId: reportId, delivery: 'unknown'};
            }
            sendJson(response, 200, status, true);
            return;
        }
        if (request.method === 'POST' && parsed.pathname === '/report' && !parsed.search) {
            handleReport(request, response);
            return;
        }
        sendJson(response, 404, {ok: false, error: 'not_found'}, true);
        request.resume();
    }

    load();
    server = http.createServer(handle);
    server.on('error', function () {
        state.lastError = 'listen_error';
        persist();
    });
    server.listen(port, host, function () { scheduleRetry(); });

    return {
        server: server,
        close: function (callback) {
            closed = true;
            if (callback) closeCallbacks.push(callback);
            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }
            if (activeRequest) {
                activeRequest.abort();
                activeRequest = null;
            }
            if (server.listening) {
                server.close(function () {
                    serverClosed = true;
                    finishCloseIfReady();
                });
            } else {
                serverClosed = true;
                process.nextTick(finishCloseIfReady);
            }
        }
    };
}

module.exports = {createRelay: createRelay};

if (typeof tizen !== 'undefined') {
    module.exports.service = createRelay();
}
