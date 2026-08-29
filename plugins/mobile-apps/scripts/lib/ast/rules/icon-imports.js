'use strict';

/**
 * Rule: only Ionicons from `@expo/vector-icons` may be imported.
 *
 * Semantic rather than lexical because the previous regex matched any text that
 * looked like an import — including one inside a comment, a doc string, or a
 * string constant — and could not tell `import { Feather }` from
 * `import { FeatherWeight }`. Reading the import declarations from the AST makes
 * both directions exact.
 */

const FORBIDDEN_MODULES = [
  { pattern: /^lucide-react-native$/, label: 'lucide-react-native' },
  { pattern: /^lucide-react$/, label: 'lucide-react' },
  { pattern: /^@tamagui\/lucide-icons(?:-2)?(?:\/.*)?$/, label: '@tamagui/lucide-icons' },
  { pattern: /^react-native-vector-icons(\/.*)?$/, label: 'react-native-vector-icons' },
  { pattern: /^\/vector-icons$/, label: 'invalid /vector-icons path' },
];

const FORBIDDEN_EXPO_FAMILIES = new Set([
  'AntDesign',
  'Entypo',
  'EvilIcons',
  'Feather',
  'Fontisto',
  'Foundation',
  'FontAwesome',
  'FontAwesome5',
  'FontAwesome6',
  'MaterialCommunityIcons',
  'MaterialIcons',
  'Octicons',
  'SimpleLineIcons',
  'Zocial',
]);

const FIX_HINT =
  'Use only `import { Ionicons } from "@expo/vector-icons"`. Ionicons has ~1300 icons; pick the closest name instead of switching icon libraries.';

module.exports = {
  id: 'icon-imports',

  run(context, sourceFile) {
    const { ts } = context;

    for (const statement of sourceFile.statements) {
      const isImport = ts.isImportDeclaration(statement);
      const isExportFrom = ts.isExportDeclaration(statement) && statement.moduleSpecifier;
      if (!isImport && !isExportFrom) continue;
      const moduleSpecifier = statement.moduleSpecifier;
      if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) continue;
      const specifier = moduleSpecifier.text;

      for (const { pattern, label } of FORBIDDEN_MODULES) {
        if (!pattern.test(specifier)) continue;
        context.report(sourceFile, statement, {
          status: 'fail',
          rule: 'icon-imports',
          message: `Forbidden icon library "${label}" imported from "${specifier}". ${FIX_HINT}`,
        });
      }

      if (specifier !== '@expo/vector-icons') continue;
      const clause = isImport ? statement.importClause : null;
      const bindings = clause && clause.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        // `propertyName` is the exported name in `import { Feather as Icon }`.
        const importedName = (element.propertyName || element.name).text;
        if (!FORBIDDEN_EXPO_FAMILIES.has(importedName)) continue;
        context.report(sourceFile, element, {
          status: 'fail',
          rule: 'icon-imports',
          message: `Forbidden "@expo/vector-icons" family "${importedName}". ${FIX_HINT}`,
        });
      }
    }
  },
};
