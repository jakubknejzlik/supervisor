import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { dictionaries } from '@supervisor/core/i18n';
const app = readFileSync('apps/dashboard/src/app.js', 'utf8');
const html = readFileSync('apps/dashboard/index.html', 'utf8');
const tree = ts.createSourceFile('app.js', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function walk(node, visit) { visit(node); ts.forEachChild(node, child => walk(child, visit)); }

it('every statically referenced UI dictionary key exists in both locales', () => {
  const keys = [...html.matchAll(/data-i18n(?:-[\w-]+)?="(\w+)"/g)].map(match => match[1]);
  walk(tree, node => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 't' && ts.isStringLiteral(node.arguments[0])) keys.push(node.arguments[0].text);
  });
  for (const key of keys) for (const locale of ['en', 'cs']) expect(dictionaries[locale], `${locale}.${key}`).toHaveProperty(key);
});
it('has no literal words at dashboard text/accessible-label rendering sites', () => {
  const findings = [];
  function inspect(node) {
    if (!node || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return;
    if (ts.isConditionalExpression(node)) { inspect(node.whenTrue); inspect(node.whenFalse); return; }
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 't') return;
    if (ts.isStringLiteral(node) && /[\p{L}]/u.test(node.text) && node.text !== 'UTC') {
      findings.push(`app.js:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`);
    }
    ts.forEachChild(node, inspect);
  }
  walk(tree, node => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(tree);
      if (['el', 'section', 'cell'].includes(callee)) inspect(node.arguments[callee === 'el' ? 1 : 0]);
      if (callee.endsWith('.setAttribute') && ts.isStringLiteral(node.arguments[0]) && ['aria-label', 'title'].includes(node.arguments[0].text)) inspect(node.arguments[1]);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && /\.(textContent|title)$/.test(node.left.getText(tree))) inspect(node.right);
  });
  expect(findings).toEqual([]);
  // The only letter outside dictionary-bound template nodes is the decorative monogram.
  const text = [...html.matchAll(/>([^<>]+)</g)].map(match => match[1].trim()).filter(Boolean);
  expect(text.filter(value => /\p{L}/u.test(value))).toEqual(['S']);
});
