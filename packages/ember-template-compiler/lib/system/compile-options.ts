import { EMBER_STRICT_MODE } from '@ember/canary-features';
import { assert } from '@ember/debug';
import { RESOLUTION_MODE_TRANSFORMS, STRICT_MODE_TRANSFORMS } from '../plugins/index';
import { EmberPrecompileOptions, PluginFunc } from '../types';
import COMPONENT_NAME_SIMPLE_DASHERIZE_CACHE from './dasherize-component-name';

let USER_PLUGINS: PluginFunc[] = [];

function malformedComponentLookup(string: string) {
  return string.indexOf('::') === -1 && string.indexOf(':') > -1;
}

export function buildCompileOptions(_options: EmberPrecompileOptions): EmberPrecompileOptions {
  let moduleName = _options.moduleName;
  let options: EmberPrecompileOptions = Object.assign(
    { meta: {}, isProduction: false, plugins: { ast: [] } },
    _options,
    {
      moduleName,
      customizeComponentName(tagname: string): string {
        assert(
          `You tried to invoke a component named <${tagname} /> in "${
            moduleName ?? '[NO MODULE]'
          }", but that is not a valid name for a component. Did you mean to use the "::" syntax for nested components?`,
          !malformedComponentLookup(tagname)
        );

        return COMPONENT_NAME_SIMPLE_DASHERIZE_CACHE.get(tagname);
      },
    }
  );

  if (!EMBER_STRICT_MODE) {
    options.strictMode = false;
    options.locals = undefined;
  }

  // move `moduleName` into `meta` property
  if (options.moduleName) {
    let meta = options.meta;
    assert('has meta', meta); // We just set it
    meta.moduleName = options.moduleName;
  }

  return options;
}

export function transformsFor(options: EmberPrecompileOptions): readonly PluginFunc[] {
  return EMBER_STRICT_MODE && options.strictMode
    ? STRICT_MODE_TRANSFORMS
    : RESOLUTION_MODE_TRANSFORMS;
}

export default function compileOptions(
  _options: Partial<EmberPrecompileOptions> = {}
): EmberPrecompileOptions {
  let options = buildCompileOptions(_options);
  let builtInPlugins = transformsFor(options);

  if (!_options.plugins) {
    options.plugins = { ast: [...USER_PLUGINS, ...builtInPlugins] };
  } else {
    let potententialPugins = [...USER_PLUGINS, ...builtInPlugins];
    assert('expected plugins', options.plugins);
    let pluginsToAdd = potententialPugins.filter((plugin) => {
      assert('expected plugins', options.plugins);
      return options.plugins.ast.indexOf(plugin) === -1;
    });
    options.plugins.ast = options.plugins.ast.concat(pluginsToAdd);
  }

  return options;
}
