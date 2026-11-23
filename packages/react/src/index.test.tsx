import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MetalCard } from "./index.tsx";

describe("<MetalCard> (server render)", () => {
  it("renders <metal-card> with its props as attributes, SSR-safe", () => {
    const html = renderToString(
      <MetalCard
        preset="brass-orbit-guilloche"
        name="Ada Lovelace"
        font="space-grotesk"
        interaction="turntable"
        autoRotate
        backdrop
        lazy={false}
        className="card"
        style={{ width: 320 }}
      />,
    );
    expect(html).toMatch(/^<metal-card /);
    for (const attr of [
      'preset="brass-orbit-guilloche"',
      'name="Ada Lovelace"',
      'font="space-grotesk"',
      'interaction="turntable"',
      'auto-rotate=""',
      'backdrop=""',
      'lazy="false"',
      'class="card"',
      'style="width:320px"',
    ])
      expect(html).toContain(attr);
    expect(html).not.toContain("paused");
  });

  it("numbers, string designs and omitted flags", () => {
    const html = renderToString(<MetalCard autoRotate={45} design='{"cardholderName":"X"}' paused quality="performance" />);
    expect(html).toContain('auto-rotate="45"');
    expect(html).toContain('design="{&quot;cardholderName&quot;:&quot;X&quot;}"');
    expect(html).toContain('paused=""');
    expect(html).toContain('quality="performance"');
    expect(renderToString(<MetalCard />)).toBe("<metal-card></metal-card>");
  });

  it("object designs are not serialised into the markup (set as a property on the client)", () => {
    const html = renderToString(<MetalCard design={{ recipe: { material: "brass" }, cardholderName: "Y" }} />);
    expect(html).toBe("<metal-card></metal-card>");
  });
});
