import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const gates = Object.freeze([
  'testReportPassed', 'productionConfigComplete', 'clinicInputsApproved',
  'privacyPolicyApproved', 'operationsApproved', 'providerSetupAuthorized', 'publicationAuthorized',
]);
/** Boolean attestations are an operator aid, never a source of consent or a deploy action. */
export function checkLaunch(input) {
  const missing = gates.filter(key => !input || !Object.hasOwn(input, key) || input[key] !== true);
  return {ready: missing.length === 0, missing};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = process.argv[2] ? JSON.parse(await readFile(process.argv[2], 'utf8')) : {};
    const result = checkLaunch(input);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ready ? 0 : 1;
  } catch {
    console.error('Launch gates unavailable: supply a valid non-secret JSON attestation file.');
    process.exitCode = 1;
  }
}
