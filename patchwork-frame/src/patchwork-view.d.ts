// Type declarations for patchwork-view custom element
declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "patchwork-view": {
        class?: string;
        "doc-url"?: string;
        "tool-id"?: string;
        key?: string | number;
      };
      "patchwork-view-2": {
        class?: string;
        "component-id"?: string;
        key?: string | number;
        children?: JSX.Element;
        ref?: HTMLElement | ((el: HTMLElement) => void);
      };
    }
  }
}

export {};
