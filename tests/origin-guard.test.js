import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
   hostnameEqualsOrIsSubdomain,
   getSenderDocumentUrl,
   hostnameFromUrl,
   isGmConnectAllowed,
   pickCookieQueryFilters,
   excludeRuleAppliesToHostname,
   formatSiteExcludeRule,
   upgradeSiteExcludeLine,
   normalizeCustomUrlsExcludes,
} from '../js/libs/origin-guard.js';
import { generateLogWrapperCode } from '../js/background/log-wrapper.js';

describe('hostnameEqualsOrIsSubdomain', () => {
   it('allows a host and its real subdomains', () => {
      assert.equal(hostnameEqualsOrIsSubdomain('google.com', 'google.com'), true);
      assert.equal(hostnameEqualsOrIsSubdomain('www.google.com', 'google.com'), true);
      assert.equal(hostnameEqualsOrIsSubdomain('a.b.google.com', '.google.com'), true);
   });

   it('rejects sibling-looking suffixes without a dot boundary', () => {
      assert.equal(hostnameEqualsOrIsSubdomain('notgoogle.com', 'google.com'), false);
      assert.equal(hostnameEqualsOrIsSubdomain('evilgoogle.com', 'google.com'), false);
      assert.equal(hostnameEqualsOrIsSubdomain('google.com.evil.test', 'google.com'), false);
   });
});

describe('sender document URL', () => {
   it('prefers the frame URL over the top-level tab URL', () => {
      assert.equal(
         getSenderDocumentUrl({
            url: 'https://iframe.example/path',
            tab: { url: 'https://top.example/' },
         }),
         'https://iframe.example/path'
      );
      assert.equal(hostnameFromUrl('https://iframe.example/path'), 'iframe.example');
   });
});

describe('isGmConnectAllowed', () => {
   it('same-origin fallback is host equality, not subdomain', () => {
      assert.equal(isGmConnectAllowed('bank.com', 'bank.com', []), true);
      assert.equal(isGmConnectAllowed('api.bank.com', 'bank.com', []), false);
      assert.equal(isGmConnectAllowed('bank.com', 'evil.com', []), false);
   });

   it('@connect self matches the frame host only', () => {
      assert.equal(isGmConnectAllowed('evil.com', 'evil.com', ['self']), true);
      assert.equal(isGmConnectAllowed('bank.com', 'evil.com', ['self']), false);
      assert.equal(isGmConnectAllowed('sub.evil.com', 'evil.com', ['self']), false);
   });

   it('@connect example.com allows that host and its subdomains', () => {
      assert.equal(isGmConnectAllowed('example.com', 'other.test', ['example.com']), true);
      assert.equal(isGmConnectAllowed('api.example.com', 'other.test', ['example.com']), true);
      assert.equal(isGmConnectAllowed('notexample.com', 'other.test', ['example.com']), false);
   });
});

describe('pickCookieQueryFilters', () => {
   it('does not copy url, method, or scriptId into the cookie query', () => {
      const query = pickCookieQueryFilters({
         url: 'https://google.com/',
         method: 'list',
         scriptId: 99,
         name: 'sid',
         domain: '.example.com',
      });
      assert.equal(query.url, undefined);
      assert.equal(query.method, undefined);
      assert.equal(query.scriptId, undefined);
      assert.equal(query.name, 'sid');
      assert.equal(query.domain, 'example.com');
   });
});

describe('excludeRuleAppliesToHostname', () => {
   it('matches the excluded host and its subdomains, not sibling suffixes', () => {
      assert.equal(excludeRuleAppliesToHostname('-*://example.com/*', 'example.com'), true);
      assert.equal(excludeRuleAppliesToHostname('-*://example.com/*', 'www.example.com'), true);
      assert.equal(excludeRuleAppliesToHostname('-*://*.example.com/*', 'foo.example.com'), true);
      assert.equal(excludeRuleAppliesToHostname('-*://notexample.com/*', 'example.com'), false);
      assert.equal(excludeRuleAppliesToHostname('-*://example.com/*', 'notexample.com'), false);
   });

   it('ignores non-exclude lines', () => {
      assert.equal(excludeRuleAppliesToHostname('*://example.com/*', 'example.com'), false);
   });
});

describe('upgradeSiteExcludeLine', () => {
   it('upgrades popup-era site-wide excludes to *.host', () => {
      assert.equal(upgradeSiteExcludeLine('-*://example.com/*'), '-*://*.example.com/*');
      assert.equal(upgradeSiteExcludeLine('-https://example.com/*'), '-*://*.example.com/*');
      assert.equal(upgradeSiteExcludeLine('-http://www.example.com/*'), '-*://*.example.com/*');
   });

   it('leaves path-specific and already-wildcard excludes unchanged', () => {
      assert.equal(upgradeSiteExcludeLine('-https://github.com/settings/*'), '-https://github.com/settings/*');
      assert.equal(upgradeSiteExcludeLine('-*://*.example.com/*'), '-*://*.example.com/*');
      assert.equal(upgradeSiteExcludeLine('*://example.com/*'), '*://example.com/*');
   });
});

describe('normalizeCustomUrlsExcludes', () => {
   it('upgrades and dedupes old site-wide exclude lines', () => {
      assert.equal(
         normalizeCustomUrlsExcludes('-*://example.com/*\n-*://*.example.com/*\n-https://github.com/settings/*'),
         '-*://*.example.com/*\n-https://github.com/settings/*'
      );
   });
});

describe('formatSiteExcludeRule', () => {
   it('writes a *.host pattern so www and apex share one rule', () => {
      assert.equal(formatSiteExcludeRule('example.com'), '-*://*.example.com/*');
      assert.equal(formatSiteExcludeRule('www.example.com'), '-*://*.example.com/*');
      assert.equal(formatSiteExcludeRule(''), '');
   });

   it('UI helper and the written rule agree on www vs sibling hosts', () => {
      const rule = formatSiteExcludeRule('www.example.com');
      assert.equal(excludeRuleAppliesToHostname(rule, 'example.com'), true);
      assert.equal(excludeRuleAppliesToHostname(rule, 'www.example.com'), true);
      assert.equal(excludeRuleAppliesToHostname(rule, 'app.example.com'), true);
      assert.equal(excludeRuleAppliesToHostname(rule, 'notexample.com'), false);
   });
});

describe('log wrapper IPC', () => {
   it('sends logs on the token CustomEvent channel, not window.postMessage', () => {
      const code = generateLogWrapperCode({
         scriptId: 1,
         pageToken: 'secret-token',
         areLogsMutedGlobally: false,
         isScriptMuted: false,
         scriptName: 'Test',
      });
      assert.match(code, /litemonkey-up-.*secret-token|litemonkey-up-' \+ \$\.pageToken/);
      assert.equal(code.includes("postMessage({"), false);
      assert.equal(code.includes("postMessage("), false);
   });
});
