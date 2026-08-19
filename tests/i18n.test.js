import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeLocale, resolveLocale } from '../public/js/i18n.js';

test('locale normalization accepts only the shipped Traditional Chinese and English catalogs', () => {
  assert.equal(normalizeLocale('zh-TW'), 'zh-Hant');
  assert.equal(normalizeLocale('zh-Hant-TW'), 'zh-Hant');
  assert.equal(normalizeLocale('zh_CN'), 'zh-Hant');
  assert.equal(normalizeLocale('en-US'), 'en');
  assert.equal(normalizeLocale('ja-JP'), '');
  assert.equal(normalizeLocale('javascript:alert(1)'), '');
});

test('locale resolution prioritizes URL, saved preference, browser languages, then Traditional Chinese', () => {
  assert.deepEqual(resolveLocale({ search: '?lang=en', stored: 'zh-Hant', languages: ['zh-TW'] }), { locale: 'en', source: 'url' });
  assert.deepEqual(resolveLocale({ search: '?lang=zh-TW', stored: 'en', languages: ['en-US'] }), { locale: 'zh-Hant', source: 'url' });
  assert.deepEqual(resolveLocale({ stored: 'en', languages: ['zh-TW'] }), { locale: 'en', source: 'saved' });
  assert.deepEqual(resolveLocale({ languages: ['ja-JP', 'en-GB'] }), { locale: 'en', source: 'browser' });
  assert.deepEqual(resolveLocale({ languages: ['ja-JP'] }), { locale: 'zh-Hant', source: 'default' });
});
