declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "patchwork-view": {
        class?: string;
        "doc-url"?: string;
        "tool-id"?: string;
        key?: string | number;
      };
    }
  }
}

export {};
