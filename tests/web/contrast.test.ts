import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/web/styles.css', 'utf8');
const style = document.createElement('style');
style.textContent = css;
document.head.append(style);

function declaration(selector: string, property: string): string {
  let result = '';
  function visit(rules: CSSRuleList) {
    for (const rule of rules) {
      if ('selectorText' in rule && 'style' in rule) {
        const typed = rule as CSSStyleRule;
        const selectors = typed.selectorText.split(',').map(item => item.trim());
        if (selector.split(',').every(item => selectors.includes(item.trim()))) {
          result = typed.style.getPropertyValue(property) || result;
        }
      } else if ('cssRules' in rule) {
        visit((rule as CSSMediaRule).cssRules);
      }
    }
  }
  visit(style.sheet!.cssRules);
  return result.trim().replace(/var\((--[\w-]+)\)/g, (_, token: string) => declaration(':root', token));
}

function rgb(color: string): number[] {
  if (color === 'white') return [255, 255, 255];
  const normalized = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color);
  if (normalized) return normalized.slice(1).map(Number);
  const hex = color.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`Expected solid sRGB color, got ${color}`);
  return [0, 2, 4].map(start => parseInt(hex.slice(start, start + 2), 16));
}

function luminance(color: string): number {
  const channels = rgb(color).map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe('normal-text shell contrast', () => {
  // Every case catches a too-light authored text color on its rendered surface.
  const cases = [
    ['p', ':root', 'white'],
    ['.brand small', ':root', 'white'],
    ['.clinic-facts small', '.clinic-facts', ''],
    ['.service-copy>span:not(.service-link)', '.service-card', ''],
    ['.muted', '.steps-card', ''],
    ['.section-caption', ':root', ''],
    ['.site-footer', ':root', ''],
    ['.small-copy', '.page-card', ''],
    ['.hero p', '', '#d5eff8'],
    ['.hero-note', '', '#d5eff8'],
    ['.eyebrow', '', '#d5eff8'],
    ['.service-link', '.service-card', ''],
    ['.desktop-nav button', '', '#ffffff'],
    ['.desktop-nav button.active', '.desktop-nav button.active', ''],
    // 96%-opaque white over black is darker than any actual page surface.
    ['.bottom-nav button', '', '#f5f5f5'],
    ['.bottom-nav button.active', '.bottom-nav button.active', ''],
    ['.primary', '.primary', ''],
    ['.steps-card li>span', '.steps-card li>span', ''],
    ['.care-window', '', '#e8f6fc'],
    ['.smile-strip p', '', '#e1f5f5'],
    ['.calendar-day.full', '.calendar-day.full', ''],
    ['.calendar-day.closed,.calendar-day.ineligible', '.calendar-day.closed,.calendar-day.ineligible', ''],
    ['.calendar-day.paused', '.calendar-day.paused', ''],
    ['.calendar-day.selected', '.calendar-day.selected', ''],
    ['.status-badge', '.status-badge', ''],
    ['.status-badge.pending', '.status-badge.pending', ''],
    ['.status-badge.approved,.status-badge.completed', '.status-badge.approved,.status-badge.completed', ''],
    ['.status-badge.rejected,.status-badge.no_show', '.status-badge.rejected,.status-badge.no_show', ''],
    ['.notice', '.notice', ''],
    ['.danger', '.danger', ''],
    ['.date-summary>strong', '.date-summary', ''],
    ['.submitted-card h1', '.submitted-card', ''],
  ];
  it.each(cases)('%s remains at least 4.5:1 on its normal/active surface', (selector, surface, conservativeBackground) => {
    const foreground = declaration(selector, 'color');
    const background = conservativeBackground || declaration(surface, 'background');
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});
