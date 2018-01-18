import {
  ComponentCapabilities,
  Option,
  ProgramSymbolTable,
  Simple,
  VMHandle
} from '@glimmer/interfaces';
import {
  combine,
  Tag,
  VersionedPathReference,
} from '@glimmer/reference';
import {
  Arguments,
  Bounds,
  ComponentDefinition,
  ElementOperations,
  Invocation,
  PreparedArguments,
  PrimitiveReference,
  WithDynamicLayout,
  WithDynamicTagName,
  WithStaticLayout,
} from '@glimmer/runtime';
import { Destroyable, EMPTY_ARRAY, Opaque } from '@glimmer/util';
import { privatize as P } from 'container';
import {
  assert,
  deprecate,
} from 'ember-debug';
import { DEBUG } from 'ember-env-flags';
import {
  _instrumentStart, get,
} from 'ember-metal';
import { String as StringUtils } from 'ember-runtime';
import {
  getOwner,
  guidFor,
} from 'ember-utils';
import { OwnedTemplateMeta, setViewElement } from 'ember-views';
import {
  BOUNDS,
  DIRTY_TAG,
  HAS_BLOCK,
  IS_DISPATCHING_ATTRS,
  ROOT_REF,
} from '../component';
import Environment from '../environment';
import { DynamicScope } from '../renderer';
import RuntimeResolver from '../resolver';
import {
  Factory as TemplateFactory,
  OwnedTemplate
} from '../template';
import {
  AttributeBinding,
  ClassNameBinding,
  ColonClassNameBindingReference,
  IsVisibleBinding,
  referenceForKey
} from '../utils/bindings';
import ComponentStateBucket, { Component } from '../utils/curly-component-state-bucket';
import { processComponentArgs } from '../utils/process-args';
import AbstractManager from './abstract';
import DefinitionState from './definition-state';

function aliasIdToElementId(args: Arguments, props: any) {
  if (args.named.has('id')) {
    // tslint:disable-next-line:max-line-length
    assert(`You cannot invoke a component with both 'id' and 'elementId' at the same time.`, !args.named.has('elementId'));
    props.elementId = props.id;
  }
}

function isTemplateFactory(template: OwnedTemplate | TemplateFactory): template is TemplateFactory {
  return typeof (template as TemplateFactory).create === 'function';
}

// We must traverse the attributeBindings in reverse keeping track of
// what has already been applied. This is essentially refining the concatenated
// properties applying right to left.
function applyAttributeBindings(element: Simple.Element, attributeBindings: Array<string>, component: Component, operations: ElementOperations) {
  let seen: string[] = [];
  let i = attributeBindings.length - 1;

  while (i !== -1) {
    let binding = attributeBindings[i];
    let parsed: [string, string, boolean] = AttributeBinding.parse(binding);
    let attribute = parsed[1];

    if (seen.indexOf(attribute) === -1) {
      seen.push(attribute);
      AttributeBinding.install(element, component, parsed, operations);
    }

    i--;
  }

  if (seen.indexOf('id') === -1) {
    operations.setAttribute('id', PrimitiveReference.create(component.elementId), true, null);
  }

  if (seen.indexOf('style') === -1) {
    IsVisibleBinding.install(element, component, operations);
  }
}

const DEFAULT_LAYOUT = P`template:components/-default`;

export default class CurlyComponentManager extends AbstractManager<ComponentStateBucket, DefinitionState>
  implements WithStaticLayout<ComponentStateBucket, DefinitionState, OwnedTemplateMeta, RuntimeResolver>,
             WithDynamicTagName<ComponentStateBucket>,
             WithDynamicLayout<ComponentStateBucket, OwnedTemplateMeta, RuntimeResolver> {

  getLayout(state: DefinitionState, _resolver: RuntimeResolver): Invocation {
    return {
      // TODO fix
      handle: state.handle as any as number,
      symbolTable: state.symbolTable!
    };
  }

  templateFor(component: Component, resolver: RuntimeResolver): OwnedTemplate {
    let layout = get(component, 'layout') as TemplateFactory | OwnedTemplate | undefined;
    if (layout !== undefined) {
      // This needs to be cached by template.id
      if (isTemplateFactory(layout)) {
        return resolver.createTemplate(layout, getOwner(component));
      } else {
        // we were provided an instance already
        return layout;
      }
    }
    let owner = getOwner(component);
    let layoutName = get(component, 'layoutName');
    if (layoutName) {
      let template = owner.lookup<OwnedTemplate>('template:' + layoutName);
      if (template) {
        return template;
      }
    }
    return owner.lookup<OwnedTemplate>(DEFAULT_LAYOUT);
  }

  getDynamicLayout({ component }: ComponentStateBucket, resolver: RuntimeResolver): Invocation {
    const template = this.templateFor(component, resolver);
    const layout = resolver.getWrappedLayout(template, CURLY_CAPABILITIES);
    return {
      handle: layout.compile(),
      symbolTable: layout.symbolTable,
    };
  }

  getTagName(state: ComponentStateBucket): Option<string> {
    const { component } = state;
    if (component.tagName === '') {
      return null;
    }
    return (component && component.tagName) || 'div';
  }

  getCapabilities(state: DefinitionState) {
    return state.capabilities;
  }

  prepareArgs(state: DefinitionState, args: Arguments): Option<PreparedArguments> {
    const { positionalParams } = state.ComponentClass.class;

    if (typeof positionalParams === 'string') {
      if (args.named.has(positionalParams)) {
        if (args.positional.length === 0) {
          return null;
        } else {
          assert(`You cannot specify positional parameters and the hash argument \`${positionalParams}\`.`, false);
        }
      }

      const named = {
        ...args.named.capture().map
      };
      named[positionalParams] = args.positional.capture();
      return { positional: EMPTY_ARRAY, named };
    } else if (Array.isArray(positionalParams)) {
      const named = {
        ...args.named.capture().map
      };
      const count = Math.min(positionalParams.length, args.positional.length);
      for (let i=0; i<count; i++) {
        const name = positionalParams[i];
        if (named[name]) {
          deprecate(`You cannot specify both a positional param (at position ${i}) and the hash argument \`${name}\`.`, !named[name], {
            id: 'ember-glimmer.positional-param-conflict',
            until: '3.5.0',
          });
        }

        named[name] = args.positional.at(i);
      }

      return { positional: EMPTY_ARRAY, named };
    } else {
      return null;
    }
  }

  create(environment: Environment, state: DefinitionState, args: Arguments, dynamicScope: DynamicScope, callerSelfRef: VersionedPathReference<Opaque>, hasBlock: boolean): ComponentStateBucket {
    if (DEBUG) {
      this._pushToDebugStack(`component:${state.name}`, environment);
    }

    let parentView = dynamicScope.view;

    let factory = state.ComponentClass;

    let capturedArgs = args.named.capture();
    let props = processComponentArgs(capturedArgs);

    aliasIdToElementId(args, props);

    props.parentView = parentView;
    props[HAS_BLOCK] = hasBlock;

    props._targetObject = callerSelfRef.value();

    // static layout asserts CurriedDefinition
    if (state.template) {
      props.layout = state.template;
    }

    let component = factory.create(props);

    let finalizer = _instrumentStart('render.component', initialRenderInstrumentDetails, component);

    dynamicScope.view = component;

    if (parentView !== null && parentView !== undefined) {
      parentView.appendChild(component);
    }

    // We usually do this in the `didCreateElement`, but that hook doesn't fire for tagless components
    if (component.tagName === '') {
      if (environment.isInteractive) {
        component.trigger('willRender');
      }

      component._transitionTo('hasElement');

      if (environment.isInteractive) {
        component.trigger('willInsertElement');
      }
    }

    let bucket = new ComponentStateBucket(environment, component, capturedArgs, finalizer);

    if (args.named.has('class')) {
      bucket.classRef = args.named.get('class');
    }

    if (DEBUG) {
      processComponentInitializationAssertions(component, props);
    }

    if (environment.isInteractive && component.tagName !== '') {
      component.trigger('willRender');
    }

    return bucket;
  }

  getSelf({ component }: ComponentStateBucket): VersionedPathReference<Opaque> {
    return component[ROOT_REF];
  }

  didCreateElement({ args, component, classRef, environment }: ComponentStateBucket, element: HTMLElement, operations: ElementOperations): void {
    setViewElement(component, element);

    let { attributeBindings, classNames, classNameBindings } = component;

    operations.setAttribute('id', PrimitiveReference.create(guidFor(component)), false, null);

    if (attributeBindings && attributeBindings.length) {
      applyAttributeBindings(element, attributeBindings, component, operations);
    } else {
      if (component.elementId) {
        operations.setAttribute('id', PrimitiveReference.create(component.elementId), false, null);
      }
      IsVisibleBinding.install(element, component, operations);
    }

    if (classRef && classRef.value()) {
      const ref = classRef.value() === true ?
                         new ColonClassNameBindingReference(classRef, StringUtils.dasherize(args!.tag.inner!['key']), null) :
                         classRef;
      operations.setAttribute('class', ref, false, null);
    }

    if (classNames && classNames.length) {
      classNames.forEach((name: string) => {
        operations.setAttribute('class', PrimitiveReference.create(name), false, null);
      });
    }

    if (classNameBindings && classNameBindings.length) {
      classNameBindings.forEach((binding: string) => {
        ClassNameBinding.install(element, component, binding, operations);
      });
    }
    operations.setAttribute('class', PrimitiveReference.create('ember-view'), false, null);

    const ariaRole = get(component, 'ariaRole');
    if (ariaRole) {
      operations.setAttribute('role', referenceForKey(component, 'ariaRole'), false, null);
    }

    component._transitionTo('hasElement');

    if (environment.isInteractive) {
      component.trigger('willInsertElement');
    }
  }

  didRenderLayout(bucket: ComponentStateBucket, bounds: Bounds): void {
    bucket.component[BOUNDS] = bounds;
    bucket.finalize();

    if (DEBUG) {
      this.debugStack.pop();
    }
  }

  getTag({ args, component }: ComponentStateBucket): Tag {
    return args ? combine([args.tag, component[DIRTY_TAG]]) :
                  component[DIRTY_TAG];
  }

  didCreate({ component, environment }: ComponentStateBucket): void {
    if (environment.isInteractive) {
      component._transitionTo('inDOM');
      component.trigger('didInsertElement');
      component.trigger('didRender');
    }
  }

  update(bucket: ComponentStateBucket): void {
    let { component, args, argsRevision, environment } = bucket;

    if (DEBUG) {
       this._pushToDebugStack(component._debugContainerKey, environment);
    }

    bucket.finalizer = _instrumentStart('render.component', rerenderInstrumentDetails, component);

    if (args && !args.tag.validate(argsRevision)) {
      let props = processComponentArgs(args!);

      bucket.argsRevision = args!.tag.value();

      component[IS_DISPATCHING_ATTRS] = true;
      component.setProperties(props);
      component[IS_DISPATCHING_ATTRS] = false;

      component.trigger('didUpdateAttrs');
      component.trigger('didReceiveAttrs');
    }

    if (environment.isInteractive) {
      component.trigger('willUpdate');
      component.trigger('willRender');
    }
  }

  didUpdateLayout(bucket: ComponentStateBucket): void {
    bucket.finalize();

    if (DEBUG) {
      this.debugStack.pop();
    }
  }

  didUpdate({ component, environment }: ComponentStateBucket): void {
    if (environment.isInteractive) {
      component.trigger('didUpdate');
      component.trigger('didRender');
    }
  }

  getDestructor(stateBucket: ComponentStateBucket): Option<Destroyable> {
    return stateBucket;
  }
}

export function validatePositionalParameters(named: { has(name: string): boolean }, positional: { length: number }, positionalParamsDefinition: any) {
  if (DEBUG) {
    if (!named || !positional || !positional.length) {
      return;
    }

    let paramType = typeof positionalParamsDefinition;

    if (paramType === 'string') {
      // tslint:disable-next-line:max-line-length
      assert(`You cannot specify positional parameters and the hash argument \`${positionalParamsDefinition}\`.`, !named.has(positionalParamsDefinition));
    } else {
      if (positional.length < positionalParamsDefinition.length) {
        positionalParamsDefinition = positionalParamsDefinition.slice(0, positional.length);
      }

      for (let i = 0; i < positionalParamsDefinition.length; i++) {
        let name = positionalParamsDefinition[i];

        assert(
          `You cannot specify both a positional param (at position ${i}) and the hash argument \`${name}\`.`,
          !named.has(name),
        );
      }
    }
  }
}

export function processComponentInitializationAssertions(component: Component, props: any) {
  assert(`classNameBindings must be non-empty strings: ${component}`, (() => {
    let { classNameBindings } = component;
    for (let i = 0; i < classNameBindings.length; i++) {
      let binding = classNameBindings[i];

      if (typeof binding !== 'string' || binding.length === 0) {
        return false;
      }
    }
    return true;
  })());

  assert(`classNameBindings must not have spaces in them: ${component}`, (() => {
    let { classNameBindings } = component;
    for (let i = 0; i < classNameBindings.length; i++) {
      let binding = classNameBindings[i];
      if (binding.split(' ').length > 1) {
        return false;
      }
    }
    return true;
  })());

  assert(`You cannot use \`classNameBindings\` on a tag-less component: ${component}`,
    component.tagName !== '' || !component.classNameBindings || component.classNameBindings.length === 0);

  assert(`You cannot use \`elementId\` on a tag-less component: ${component}`,
    component.tagName !== '' || props.id === component.elementId ||
    (!component.elementId && component.elementId !== ''));

  assert(`You cannot use \`attributeBindings\` on a tag-less component: ${component}`,
    component.tagName !== '' || !component.attributeBindings || component.attributeBindings.length === 0);
}

export function initialRenderInstrumentDetails(component: any): any {
  return component.instrumentDetails({ initialRender: true });
}

export function rerenderInstrumentDetails(component: any): any {
  return component.instrumentDetails({ initialRender: false });
}

// This is not any of glimmer-vm's proper Argument types because we
// don't have sufficient public constructors to conveniently
// reassemble one after we mangle the various arguments.
interface CurriedArgs {
  positional: any[];
  named: any;
}

export const CURLY_CAPABILITIES: ComponentCapabilities = {
  dynamicLayout: true,
  dynamicTag: true,
  prepareArgs: true,
  createArgs: true,
  attributeHook: true,
  elementHook: true
};

const CURLY_COMPONENT_MANAGER = new CurlyComponentManager();
export class CurlyComponentDefinition implements ComponentDefinition {
  public template: OwnedTemplate;
  public args: CurriedArgs | undefined;
  public state: DefinitionState;
  public symbolTable: ProgramSymbolTable | undefined;

  // tslint:disable-next-line:no-shadowed-variable
  constructor(public name: string, public manager: CurlyComponentManager = CURLY_COMPONENT_MANAGER, public ComponentClass: any, public handle: Option<VMHandle>, template: OwnedTemplate, args?: CurriedArgs) {
    const layout = template && template.asLayout();
    const symbolTable = layout ? layout.symbolTable : undefined;
    this.symbolTable = symbolTable;
    this.template = template;
    this.args = args;
    this.state = {
      name,
      ComponentClass,
      handle,
      template,
      capabilities: CURLY_CAPABILITIES,
      symbolTable
    };
  }
}
