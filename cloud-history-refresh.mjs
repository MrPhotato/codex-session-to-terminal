import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_RECEIVED_BYTES = 2 * MAX_FRAME_BYTES;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code, message) => Object.assign(new Error(message), { code });

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

/**
 * Experimental Desktop coordination protocol, observed in 26.1013.4894.0.
 * transportFactory MUST be verifiedDesktopTransport(...) or an equivalent
 * factory that verifies the Desktop peer on the same handle before returning.
 * It must supply a fresh, exclusively owned duplex and honor the abort signal.
 * This module cannot authenticate an arbitrary caller-supplied factory.
 *
 * Only invalidates one history cache key. It neither reads the conversation nor
 * controls generation. Success confirms a local broadcast write, not renderer
 * processing, a fresh server response, or completion of a cloud turn.
 */
export async function markCloudHistoryStale({ conversationId, transportFactory, timeoutMs = 10000, ...unsupported } = {}) {
  if (Object.keys(unsupported).length) throw failure('INVALID_OPTIONS', 'Only conversationId, transportFactory and timeoutMs are supported.');
  if (typeof conversationId !== 'string' || !UUID.test(conversationId)) {
    throw failure('INVALID_CONVERSATION', 'A single canonical conversation UUID is required.');
  }
  if (typeof transportFactory !== 'function') throw failure('VERIFIED_TRANSPORT_REQUIRED', 'A verified Desktop transport factory is required.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw failure('INVALID_TIMEOUT', 'timeoutMs must be an integer from 1 to 60000.');
  }

  return new Promise((resolve, reject) => {
    const abort = new AbortController(), requestId = randomUUID();
    let stream, settled = false, stage = 'connecting', broadcastAttempted = false, localWriteAccepted = false, invalidationSent = false;
    let receivedBytes = 0, header = Buffer.alloc(4), headerUsed = 0, body = null, bodyUsed = 0;
    const timer = setTimeout(() => fail(failure('TIMEOUT', 'Desktop cache invalidation exceeded its total deadline.')), timeoutMs);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream?.removeListener('data', onData);
      stream?.removeListener('end', onEnd);
      stream?.removeListener('close', onClose);
      // Keep the error listener through asynchronous destruction/abort errors.
      abort.abort();
      stream?.destroy();
      if (error) reject(Object.assign(error, { invalidationSent, refreshConfirmed: false,
        deliveryUnknown: broadcastAttempted && !invalidationSent }));
      else resolve({ invalidationSent: true, refreshConfirmed: false });
    }
    function fail(error) { finish(error); }
    function onError() { fail(failure('TRANSPORT_ERROR', 'The verified Desktop transport failed.')); }
    function onEnd() {
      if (stage !== 'closing') fail(failure('DISCONNECTED', 'Desktop disconnected before the broadcast was written.'));
    }
    function onClose() {
      if (stage === 'closing' && localWriteAccepted) { invalidationSent = true; finish(); }
      else fail(failure('DISCONNECTED', 'Desktop disconnected before the broadcast was written.'));
    }

    function receive(message) {
      if (!object(message)) throw failure('PROTOCOL_ERROR', 'Desktop sent an invalid frame.');
      if (message.type !== 'response' || message.requestId !== requestId) return;
      if (message.resultType === 'error') throw failure('INITIALIZE_REJECTED', 'Desktop rejected client initialization.');
      if (message.resultType !== 'success' || message.method !== 'initialize' ||
          !object(message.result) || typeof message.result.clientId !== 'string' || !UUID.test(message.result.clientId)) {
        throw failure('PROTOCOL_ERROR', 'Desktop did not return a valid client identity.');
      }
      stage = 'writing';
      broadcastAttempted = true;
      stream.write(frame({ type: 'broadcast', method: 'query-cache-invalidate', version: 0,
        sourceClientId: message.result.clientId, params: { queryKey: ['chatgpt-conversation', conversationId], reset: false } }), error => {
        if (settled) return;
        if (error) { onError(); return; }
        localWriteAccepted = true;
        stage = 'closing';
        // The verified factory may proxy through a child process. EOF lets it
        // forward buffered bytes before exiting; immediate destruction can lose
        // the broadcast. The original deadline also bounds this graceful close.
        try { stream.end(); } catch { onError(); }
      });
    }

    function onData(chunk) {
      if (settled || stage !== 'initializing') return;
      try {
        if (!(chunk instanceof Uint8Array)) throw failure('PROTOCOL_ERROR', 'Desktop transport must return binary frames.');
        receivedBytes += chunk.byteLength;
        if (receivedBytes > MAX_RECEIVED_BYTES) throw failure('RECEIVE_LIMIT', 'Desktop initialization exceeded the receive limit.');
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let offset = 0;
        while (offset < bytes.length && stage === 'initializing' && !settled) {
          if (body === null) {
            const length = Math.min(4 - headerUsed, bytes.length - offset);
            bytes.copy(header, headerUsed, offset, offset + length);
            headerUsed += length; offset += length;
            if (headerUsed < 4) continue;
            const size = header.readUInt32LE(0);
            if (!size || size > MAX_FRAME_BYTES) throw failure('FRAME_TOO_LARGE', 'Desktop initialization frame exceeds the permitted size.');
            body = Buffer.alloc(size); bodyUsed = 0;
          }
          const length = Math.min(body.length - bodyUsed, bytes.length - offset);
          bytes.copy(body, bodyUsed, offset, offset + length);
          bodyUsed += length; offset += length;
          if (bodyUsed === body.length) {
            let message;
            try { message = JSON.parse(body.toString('utf8')); }
            catch { throw failure('PROTOCOL_ERROR', 'Desktop sent invalid JSON.'); }
            body = null; bodyUsed = 0; headerUsed = 0;
            receive(message);
          }
        }
      } catch (error) { fail(error?.code ? error : failure('PROTOCOL_ERROR', 'Desktop initialization failed.')); }
    }

    Promise.resolve().then(() => transportFactory({ signal: abort.signal })).then(transport => {
      if (settled) { transport?.on?.('error', () => {}); transport?.destroy?.(); return; }
      if (!transport || typeof transport.on !== 'function' || typeof transport.removeListener !== 'function' ||
          typeof transport.write !== 'function' || typeof transport.end !== 'function' || typeof transport.destroy !== 'function' ||
          transport.destroyed || !transport.writable) {
        transport?.on?.('error', () => {}); transport?.destroy?.();
        fail(failure('INVALID_TRANSPORT', 'The verified factory must return a connected duplex stream.'));
        return;
      }
      stream = transport;
      stream.on('error', onError);
      stream.on('end', onEnd);
      stream.on('close', onClose);
      stream.on('data', onData);
      stage = 'initializing';
      try {
        stream.write(frame({ type: 'request', requestId, sourceClientId: 'initializing-client', version: 0,
          method: 'initialize', params: { clientType: 'cst-terminal' } }), error => { if (error) onError(); });
      } catch { onError(); }
    }, () => fail(failure('CONNECTION_FAILED', 'The verified Desktop connection could not be established.')))
      .catch(() => fail(failure('TRANSPORT_ERROR', 'The verified Desktop transport failed.')));
  });
}
