const { Linter } = require("eslint");

// Compare syntax while ignoring only local binding names. ESLint's scope analysis
// keeps references tied to their declarations; property names and globals retain
// their spelling, so renaming a binding cannot hide a changed property or call.
function normalizeAssembly(contents) {
  let normalized;
  const messages = new Linter().verify(contents, {
    languageOptions: { ecmaVersion: "latest", sourceType: "commonjs" },
    plugins: {
      assembly: {
        rules: {
          normalize: {
            create(context) {
              return {
                "Program:exit"() {
                  const source = context.sourceCode;
                  const bindings = source.scopeManager.scopes
                    .flatMap((scope) => scope.variables)
                    .filter((variable) => variable.identifiers.length)
                    .sort((a, b) => a.identifiers[0].range[0] - b.identifiers[0].range[0]);
                  const names = new Map();
                  bindings.forEach((variable, index) => {
                    for (const identifier of [
                      ...variable.identifiers,
                      ...variable.references.map((reference) => reference.identifier),
                    ]) {
                      let property = identifier.parent;
                      if (property.type === "AssignmentPattern") property = property.parent;
                      names.set(identifier.range[0], {
                        name: `binding${index}`,
                        key:
                          property.type === "Property" && property.shorthand
                            ? property.key.name
                            : undefined,
                      });
                    }
                  });
                  normalized = JSON.stringify(
                    source.getTokens(source.ast).flatMap((token) => {
                      const binding = names.get(token.range[0]);
                      if (!binding) return [[token.type, token.value]];
                      const value = ["Binding", binding.name];
                      return binding.key === undefined
                        ? [value]
                        : [["Identifier", binding.key], ["Punctuator", ":"], value];
                    })
                  );
                },
              };
            },
          },
        },
      },
    },
    rules: { "assembly/normalize": "error" },
  });
  if (messages.length || normalized === undefined) {
    throw new Error(
      `Cannot parse routine assembly: ${messages.map((item) => item.message).join("; ")}`
    );
  }
  return normalized;
}

module.exports = { normalizeAssembly };
