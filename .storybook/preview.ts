import type { Preview } from "@storybook/html";

const preview: Preview = {
  parameters: {
    backgrounds: {
      default: "light",
      values: [
        { name: "light", value: "#f5f5f5" },
        { name: "dark", value: "#1a1a2e" },
      ],
    },
  },
};

export default preview;
