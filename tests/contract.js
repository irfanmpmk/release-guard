// Checks a response body against the schema openapi.json declares for that
// method, path and status. Shared by the Jest integration tests and the
// Playwright smoke tests, so the contract is enforced before and after deploy.
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const spec = require("../openapi.json");

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(spec, "spec");

const cache = new Map();

function resolveRef(ref) {
  return ref
    .replace(/^#\//, "")
    .split("/")
    .reduce((node, key) => node[key], spec);
}

function validatorFor(path, method, status) {
  const key = `${method} ${path} ${status}`;
  if (cache.has(key)) return cache.get(key);
  let response = spec.paths[path]?.[method]?.responses?.[String(status)];
  if (!response) throw new Error(`openapi.json does not document ${method.toUpperCase()} ${path} -> ${status}`);
  if (response.$ref) response = resolveRef(response.$ref);
  const schema = response.content?.["application/json"]?.schema;
  // Point local refs at the registered spec so they resolve.
  const validate = schema && ajv.compile(JSON.parse(JSON.stringify(schema).replaceAll('"#/components', '"spec#/components')));
  cache.set(key, validate);
  return validate;
}

/** Throws if `body` does not match the documented response. */
function assertContract(path, method, status, body) {
  const validate = validatorFor(path, method.toLowerCase(), status);
  if (validate && !validate(body)) {
    throw new Error(`${method.toUpperCase()} ${path} ${status} breaks the contract: ${ajv.errorsText(validate.errors)}`);
  }
}

module.exports = { assertContract };
