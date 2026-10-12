import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const style = document.createElement('style');
const css = readFileSync('src/web/styles.css', 'utf8');
style.textContent = css;
document.head.append(style);
function declarations(selector: string, property: string) {
  const values: string[] = [];
  function visit(rules: CSSRuleList) {
    for (const rule of rules) {
      if ('selectorText' in rule && 'style' in rule) {
        const typed = rule as CSSStyleRule;
        if (typed.selectorText.split(',').map(value => value.trim()).includes(selector)) {
          const value = typed.style.getPropertyValue(property);
          if (value) values.push(value.trim());
        }
      } else if ('cssRules' in rule) visit((rule as CSSMediaRule).cssRules);
    }
  }
  visit(style.sheet!.cssRules);
  return values;
}

// Authored style safeguards, not a substitute for browser reflow/visual QA.
describe('mobile readability safeguards', () => {
  it('sets readable body/input sizes rather than small desktop-form text', () => {
    expect(declarations(':root', 'font-size')).toContain('17px');
    expect(declarations('.field input', 'font-size')).toContain('16px');
  });
  it('keeps seven flexible month columns at every viewport and switches only on explicit list choice', () => {
    expect(declarations('.calendar-grid', 'grid-template-columns')).toEqual(['repeat(7,minmax(0,1fr))']);
    expect(declarations('.calendar[data-view="list"] .calendar-grid', 'grid-template-columns')).toContain('minmax(0,1fr)');
    expect(declarations('.calendar[data-view="list"] .compact-date', 'display')).toContain('block');
    expect(declarations('.calendar-day', 'min-height')).toContain('44px');
    expect(declarations('.calendar-day', 'min-width')).toContain('0px');
  });
  it('keeps enlarged date numerals unbroken and gives the phone date step extra inline room', () => {
    expect(declarations('.calendar-day strong', 'white-space')).toContain('nowrap');
    expect(declarations('.calendar-day strong', 'overflow-wrap')).not.toContain('anywhere');
    expect(declarations('.calendar-day', 'padding')).toContain('5px 0px');
    expect(declarations('.date-flow-card', 'padding-left')).toContain('10px');
    expect(declarations('.date-flow-card', 'padding-right')).toContain('10px');
  });
  it('groups review and admin content into bounded responsive cards', () => {
    expect(declarations('.review-cards', 'grid-template-columns')).toContain('repeat(2,minmax(0,1fr))');
    expect(declarations('.review-cards', 'grid-template-columns')).toContain('minmax(0,1fr)');
    expect(declarations('.review-card', 'min-width')).toContain('0px');
    expect(declarations('.admin-summary-card', 'min-width')).toContain('0px');
    expect(declarations('.admin-card-details', 'overflow-wrap')).toContain('anywhere');
    expect(declarations('.admin-notifications', 'overflow-wrap')).toContain('anywhere');
  });
  it('respects both safe areas and stops loading animation for reduced motion', () => {
    // jsdom drops env() values; inspect those declarations directly, not computed layout.
    expect(css).toMatch(/\.site-header\s*\{[^}]*padding-top:\s*env\(safe-area-inset-top/);
    expect(css).toMatch(/\.bottom-nav\s*\{[^}]*padding-bottom:\s*calc\([^;]*safe-area-inset-bottom/);
    expect(declarations('.auth-spinner', 'animation')).toContain('none');
  });
});

describe('approved v6 presentation safeguards', () => {
  it('keeps the booking entry large and the review dock above measured navigation', () => {
    expect(declarations('.home-primary', 'min-height')).toContain('64px');
    expect(declarations('.review-submit-dock', 'position')).toContain('fixed');
    expect(css).toMatch(/\.review-submit-dock\s*\{[^}]*bottom:\s*var\(--bottom-nav-height/);
    expect(css).toMatch(/\.review-flow-card\s*\{[^}]*padding-bottom:\s*calc\(var\(--review-dock-height/);
  });
  it('fully hides descendants of inactive flows including fixed submission controls', () => {
    expect(declarations('[hidden]', 'display')).toContain('none');
  });
});

describe('approved v9 dental shortcut sizing', () => {
  it('uses a consistent larger icon container and dental line drawing', () => {
    expect(declarations('.home-service .tooth-icon', 'width')).toContain('48px');
    expect(declarations('.home-service .tooth-icon', 'height')).toContain('48px');
    expect(declarations('.home-service .tooth-icon svg', 'width')).toContain('30px');
    expect(declarations('.home-service .tooth-icon svg', 'height')).toContain('30px');
    expect(declarations('.home-service', 'min-height')).toContain('82px');
  });
});
