/** Minimal render contract shared by the ported transcript/markdown renderers. */
export interface Component {
  render(width: number): string[];
}
