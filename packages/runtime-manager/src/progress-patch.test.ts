import {test,expect} from 'vitest';
// @ts-expect-error runtime module is shipped without declarations
import {patchProgress} from '../runtime/progress-patch.mjs';
test('progress patch is scoped to matching run and only exposes whitelisted public fields',()=>{
 const source='function connect(){\n\t\tif (evt.runId !== responseId) return;\n\t\tif (closed) return;\n}';
 const patched=patchProgress(source);
 expect(patchProgress(patched)).toBe(patched);
 expect(patched.indexOf('evt.runId !== responseId')).toBeLessThan(patched.indexOf('type: "nexus.tool"'));
 expect(patched).not.toContain('evt.data.args');
 expect(patched).not.toContain('evt.data.result');
 expect(()=>patchProgress('unrecognized bundle')).toThrow();
});
