export {
  addChildView,
  isSimpleClick,
  getViewBounds,
  getViewClientRects,
  getViewBoundingClientRect,
  getRootViews,
  getChildViews,
  getViewId,
  getElementView,
  getViewElement,
  setElementView,
  setViewElement,
  clearElementView,
  clearViewElement,
  constructStyleDeprecationMessage,
} from './lib/system/utils';
export { default as EventDispatcher } from './lib/system/event_dispatcher';
export { default as ComponentLookup } from './lib/component_lookup';
export { default as TextSupport } from './lib/mixins/text_support';
export { default as CoreView } from './lib/views/core_view';
export { default as ClassNamesSupport } from './lib/mixins/class_names_support';
export { default as ChildViewsSupport } from './lib/mixins/child_views_support';
export { default as ViewStateSupport } from './lib/mixins/view_state_support';
export { default as ViewMixin } from './lib/mixins/view_support';
export { default as ActionSupport } from './lib/mixins/action_support';
export { MUTABLE_CELL } from './lib/compat/attrs';
export { default as ActionManager } from './lib/system/action_manager';
