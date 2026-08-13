// 给 admin-dashboard bundle 加「服务线」列 + 编辑表单字段。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const P = '/home/openclaw/makaron-openclaw/.openclaw-local/workspace/dealclaw/packages/admin-dashboard/public/assets/index-PSqnJDjD.js';
let s = readFileSync(P, 'utf8');

const edits = [
  // 1) thead：分类 后加 服务线
  {
    from: `(0,p.jsx)(\`th\`,{children:\`分类\`}),(0,p.jsx)(\`th\`,{children:\`作者\`})`,
    to: `(0,p.jsx)(\`th\`,{children:\`分类\`}),(0,p.jsx)(\`th\`,{children:\`服务线\`}),(0,p.jsx)(\`th\`,{children:\`作者\`})`,
  },
  // 2) tbody：category 单元格后加 serviceLine 单元格
  {
    from: `(0,p.jsx)(\`td\`,{children:(0,p.jsx)(D,{children:w[e.category]??e.category})}),(0,p.jsx)(\`td\`,{children:e.responsiblePerson??\`—\`})`,
    to: `(0,p.jsx)(\`td\`,{children:(0,p.jsx)(D,{children:w[e.category]??e.category})}),(0,p.jsx)(\`td\`,{children:e.serviceLine??\`—\`}),(0,p.jsx)(\`td\`,{children:e.responsiblePerson??\`—\`})`,
  },
  // 3) FormData：提交时带上 serviceLine
  {
    from: `responsiblePerson:t.get(\`responsiblePerson\`)||null,cost:t.get(\`cost\`)?Number(t.get(\`cost\`)):null})`,
    to: `responsiblePerson:t.get(\`responsiblePerson\`)||null,serviceLine:t.get(\`serviceLine\`)||null,cost:t.get(\`cost\`)?Number(t.get(\`cost\`)):null})`,
  },
  // 4) 编辑表单：分类 select 后加 服务线 select
  {
    from: `(0,p.jsx)(\`option\`,{value:\`other\`,children:\`其他\`})]})}),`,
    to: `(0,p.jsx)(\`option\`,{value:\`other\`,children:\`其他\`})]})}),(0,p.jsx)(j,{label:\`服务线\`,children:(0,p.jsxs)(\`select\`,{name:\`serviceLine\`,defaultValue:e?.serviceLine??\`\`,children:[(0,p.jsx)(\`option\`,{value:\`\`,children:\`—\`}),(0,p.jsx)(\`option\`,{value:\`DealClaw获客\`,children:\`DealClaw获客\`}),(0,p.jsx)(\`option\`,{value:\`奥创\`,children:\`奥创\`}),(0,p.jsx)(\`option\`,{value:\`星擎\`,children:\`星擎\`}),(0,p.jsx)(\`option\`,{value:\`米奥\`,children:\`米奥\`}),(0,p.jsx)(\`option\`,{value:\`CSM\`,children:\`CSM\`}),(0,p.jsx)(\`option\`,{value:\`网关\`,children:\`网关\`}),(0,p.jsx)(\`option\`,{value:\`创意生产\`,children:\`创意生产\`}),(0,p.jsx)(\`option\`,{value:\`内部\`,children:\`内部\`})]})}),`,
  },
];

// 备份
const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
copyFileSync(P, `${P}.bak-${ts}`);

for (const e of edits) {
  const n = s.split(e.from).length - 1;
  if (n !== 1) {
    console.error(`❌ 目标出现 ${n} 次（预期 1）：${e.from.slice(0, 50)}`);
    process.exit(1);
  }
  s = s.replace(e.from, e.to);
}

writeFileSync(P, s);
console.log(`✅ 4 处替换完成，备份：index-PSqnJDjD.js.bak-${ts}`);
