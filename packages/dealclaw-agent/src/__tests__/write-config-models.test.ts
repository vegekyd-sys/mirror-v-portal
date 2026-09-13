import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const script = path.join(repoRoot, 'runtime', 'write-config.mjs');
function render(document: Record<string, unknown>): any {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-model-'));
  execFileSync('node', [script], { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_WORKSPACE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'dc-work-')), OPENCLAW_CONFIG_PATH: path.join(stateDir, 'openclaw.json'), LLM_PROVIDERS: JSON.stringify(document) } });
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'openclaw.json'), 'utf8'));
}
describe('write-config model compatibility snapshot', () => {
  it('uses confirmed snapshot limits and omits unknown fields', () => {
    const config=render({providers:[{name:'qwen',baseUrl:'https://example.test/v1',apiKey:'secret',models:[{id:'qwen-long',modelType:'chat',protocol:'openai-completions',contextWindow:1000000,maxOutputTokens:131072,inputModalities:['text','image'],vision:true,maxReasoningTokens:99,unknown:'drop'}]}],defaultModel:'qwen/qwen-long',fallbackModels:[]});
    const model=config.models.providers.qwen.models[0];
    expect(model.contextWindow).toBe(1000000);expect(model.maxTokens).toBe(131072);expect(model.input).toEqual(['text','image']);expect(model.maxReasoningTokens).toBeUndefined();expect(model.unknown).toBeUndefined();
  });
  it('filters non-chat and incompatible models while retaining legacy entries',()=>{
    const config=render({providers:[{name:'mixed',baseUrl:'https://example.test/v1',apiKey:'secret',models:[{id:'legacy'},{id:'embed',modelType:'embedding'},{id:'bad',modelType:'chat',protocol:'responses'}]}],defaultModel:'mixed/legacy',fallbackModels:[]});
    expect(config.models.providers.mixed.models.map((model:any)=>model.id)).toEqual(['legacy']);
  });
});
