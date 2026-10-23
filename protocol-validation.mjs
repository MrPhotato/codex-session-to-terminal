import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
const validator = new Ajv({ strict: false, validateFormats: false });
const compiled = new Map();
const schemas = new Set(['ServerNotification', 'v2/ThreadResumeResponse', 'v2/ThreadTurnsListResponse', 'v2/ThreadItemsListResponse']);
export function validateProtocol(schema, value) {
  if (!schemas.has(schema)) throw Object.assign(new Error('Unsupported official protocol schema.'), { code: 'UNSUPPORTED_PROTOCOL_SCHEMA' });
  if (!compiled.has(schema)) compiled.set(schema, validator.compile(JSON.parse(readFileSync(new URL(`./protocol-schema/${schema}.json`, import.meta.url), 'utf8'))));
  const check = compiled.get(schema);
  if (!check(value)) {
    // Never include data values; schema paths are enough for a private-data-safe
    // diagnostic of the adapter.
    const details = check.errors?.slice(0, 3).map(error => `${error.instancePath || '/'} ${error.keyword}`).join('; ');
    throw Object.assign(new Error(`Official protocol schema ${schema} rejected the projection: ${details}`), { code: 'PROTOCOL_SCHEMA_MISMATCH' });
  }
  return value;
}
