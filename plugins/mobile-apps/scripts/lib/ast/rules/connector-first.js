'use strict';

/**
 * Rule: Power Platform data must flow through generated connector services.
 *
 * Blocks `axios` and direct `fetch()` calls to Graph / Azure Management / AAD /
 * Dataverse hosts. Semantic resolution matters here because generated screens
 * frequently build the URL first:
 *
 *     const GRAPH_ME = 'https://graph.microsoft.com/v1.0/me';
 *     await fetch(GRAPH_ME);
 *
 * The old regex only saw `fetch("https://…")` and missed the constant form,
 * while flagging the same URL when it appeared inside a comment.
 */

const FORBIDDEN_MODULES = [
  {
    pattern: /^axios(\/.*)?$/,
    message: '`axios` is forbidden. Use generated connector services from `src/generated/`.',
  },
];

const FORBIDDEN_HOSTS = [
  {
    test: (url) => /^https:\/\/graph\.microsoft\.com\b/i.test(url),
    message:
      'Direct Microsoft Graph fetch is forbidden. Add the Office 365 / Graph connector via `npx power-apps add-data-source` and import the typed client from `src/generated/`.',
  },
  {
    test: (url) => /^https:\/\/management\.azure\.com\b/i.test(url),
    message: 'Direct Azure Management REST fetch is forbidden. Use the Azure connector or a custom connector.',
  },
  {
    test: (url) => /^https:\/\/login\.microsoftonline\.com\b/i.test(url),
    message:
      'Direct AAD login fetch is forbidden. Auth is handled by the template (`expo-msal-intune` / `expo-auth-session`).',
  },
  {
    test: (url) => /^https:\/\/[^/\s]+\.crm(?:\d+)?\.dynamics\.com\b/i.test(url),
    message:
      'Direct Dataverse REST fetch is forbidden. Use the Dataverse generated service via `npx power-apps add-data-source --api-id dataverse --org-url <env-url> --resource-name <table-logical-name>`.',
  },
];

module.exports = {
  id: 'connector-first',

  appliesTo(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    // Same scope as the legacy validator: app code only, never plugin samples.
    // (node_modules, src/generated, .expo, dist and build are filtered upstream.)
    if (normalized.includes('/shared/samples/')) return false;
    return normalized.includes('/app/') || normalized.includes('/src/');
  },

  run(context, sourceFile) {
    const { ts, resolver } = context;

    resolver.walk([sourceFile], (node) => {
      const nodeSource = node.getSourceFile();
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        for (const { pattern, message } of FORBIDDEN_MODULES) {
          if (pattern.test(specifier)) {
            context.report(nodeSource, node, { status: 'fail', rule: 'connector-first', message });
          }
        }
      }

      if (ts.isCallExpression(node)) {
        const calleeText = node.expression.getText(nodeSource);
        const calleeRoot = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.expression
          : node.expression;
        if (ts.isIdentifier(calleeRoot)) {
          const binding = resolver.importBindingFor(calleeRoot);
          if (binding) {
            for (const { pattern, message } of FORBIDDEN_MODULES) {
              if (pattern.test(binding.moduleSpecifier)) {
                context.report(nodeSource, node, { status: 'fail', rule: 'connector-first', message });
              }
            }
          }
        }

        if (/^require$/.test(calleeText) && node.arguments.length === 1) {
          const evaluated = resolver.evaluateStrings(node.arguments[0]);
          for (const value of evaluated.values) {
            for (const { pattern, message } of FORBIDDEN_MODULES) {
              if (pattern.test(value.text)) {
                context.report(nodeSource, node, { status: 'fail', rule: 'connector-first', message });
              }
            }
          }
        }

        if (/(^|\.)fetch$/.test(calleeText) && node.arguments.length > 0) {
          const evaluated = resolver.evaluateStrings(node.arguments[0]);
          if (evaluated.values.length === 0 && evaluated.unknown) {
            // Only report unknown when the argument is genuinely opaque AND the
            // file has no connector import to explain it. A fully dynamic URL is
            // common in generated code, so keep this quiet unless it is the only
            // network path in the file.
            if (!nodeSource.text.includes('src/generated') && !nodeSource.text.includes('@/generated')) {
              context.report(nodeSource, node, {
                status: 'unknown',
                rule: 'connector-first',
                message:
                  'fetch() target could not be resolved statically. Confirm this call goes through a generated connector service rather than a Power Platform endpoint.',
              });
            }
          }
          for (const value of evaluated.values) {
            for (const host of FORBIDDEN_HOSTS) {
              if (host.test(value.text)) {
                context.report(nodeSource, node, {
                  status: 'fail',
                  rule: 'connector-first',
                  message: host.message,
                });
              }
            }
          }
        }
      }
    });
  },
};
