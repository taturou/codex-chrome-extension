import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SafeMarkdown } from '../shared/markdown';

describe('SafeMarkdown', () => {
  it('GFMの表とネストリストを描画できる', () => {
    const markdown = [
      '| col1 | col2 |',
      '| --- | --- |',
      '| a | b |',
      '',
      '- parent',
      '  - child'
    ].join('\n');

    const html = renderToStaticMarkup(createElement(SafeMarkdown, { markdown }));

    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('<ul>');
    expect(html).toContain('parent');
    expect(html).toContain('child');
  });

  it('危険なHTMLを実行可能な要素として描画しない', () => {
    const markdown = '<script>alert(1)</script> [x](javascript:alert(2))';

    const html = renderToStaticMarkup(createElement(SafeMarkdown, { markdown }));

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:alert(2)"');
  });
});
