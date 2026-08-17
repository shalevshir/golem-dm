import { describe, expect, it } from "vitest";
import { ActionRejectedPayload } from "@ai-dm/schemas";
import { adapterRejection, engineRejection } from "./action-rejected.js";
import { TACTICAL_PROMPT_VERSION } from "./prompt-text.js";

const spec = { provider: "google" as const, modelId: "gemini-3-flash" };

const proposedTurn = {
  actorId: "gob-1",
  mainAction: { actionType: "attack" as const, targetIds: ["pc-1"] },
  tacticalRationaleEnglish: "Swing at the hero.",
};

describe("engineRejection", () => {
  it("carries every rejection reason, so one retry sees all the problems", () => {
    const payload = engineRejection(
      "gob-1",
      1,
      [
        { reason: "target_out_of_reach", message: "pc-1 is 20 ft away", subjectId: "pc-1" },
        { reason: "action_already_used", message: "already acted" },
      ],
      proposedTurn,
      spec,
    );

    expect(payload.stage).toBe("engine");
    expect(payload.reasons).toStrictEqual(["target_out_of_reach", "action_already_used"]);
    expect(payload.messages).toStrictEqual(["pc-1 is 20 ft away", "already acted"]);
  });

  it("stamps the model that produced it, which is what step 7b groups by", () => {
    const payload = engineRejection("gob-1", 1, [], proposedTurn, spec);

    expect(payload.provider).toBe("google");
    expect(payload.modelId).toBe("gemini-3-flash");
  });

  it("keeps the rejected proposal", () => {
    const payload = engineRejection("gob-1", 2, [], proposedTurn, spec);

    expect(payload.proposedTurn).toStrictEqual(proposedTurn);
    expect(payload.attempt).toBe(2);
  });

  it("produces something the persisted schema accepts", () => {
    const payload = engineRejection(
      "gob-1",
      1,
      [{ reason: "target_not_found", message: "no such combatant" }],
      proposedTurn,
      spec,
    );

    expect(ActionRejectedPayload.safeParse(payload).success).toBe(true);
  });
});

describe("adapterRejection", () => {
  it("records the adapter's code instead of engine reasons", () => {
    const payload = adapterRejection(
      "gob-1",
      1,
      { code: "no_tool_call", message: "The model answered in prose." },
      spec,
    );

    expect(payload.stage).toBe("adapter");
    expect(payload.adapterErrorCode).toBe("no_tool_call");
    expect(payload.messages).toStrictEqual(["The model answered in prose."]);
    expect(payload.reasons).toBeUndefined();
  });

  it("has no proposal to record, because the model produced none", () => {
    const payload = adapterRejection(
      "gob-1",
      1,
      { code: "provider_error", message: "429 rate limited" },
      spec,
    );

    expect(payload.proposedTurn).toBeUndefined();
    expect(ActionRejectedPayload.safeParse(payload).success).toBe(true);
  });
});

describe("prompt version stamping", () => {
  // Step 7b compares models across benchmark runs. If the prompt is edited
  // between two runs and nothing in the event records which prompt produced
  // which rejection, the two runs pool silently and the comparison is wrong.
  //
  // Every assertion below also checks the value is a non-empty string. Without
  // that, an absent export and an absent field are both `undefined` and the
  // comparison passes while nothing exists — which is exactly how these tests
  // first passed before either was implemented.
  it("exports a non-empty prompt version", () => {
    expect(TACTICAL_PROMPT_VERSION).toMatch(/\S/);
  });

  it("stamps the prompt version on an engine rejection", () => {
    const payload = engineRejection("gob-1", 1, [], proposedTurn, spec);

    expect(payload.promptVersion).toMatch(/\S/);
    expect(payload.promptVersion).toBe(TACTICAL_PROMPT_VERSION);
  });

  it("stamps the prompt version on an adapter rejection too", () => {
    const payload = adapterRejection(
      "gob-1",
      1,
      { code: "no_tool_call", message: "The model answered in prose." },
      spec,
    );

    expect(payload.promptVersion).toMatch(/\S/);
    expect(payload.promptVersion).toBe(TACTICAL_PROMPT_VERSION);
  });

  it("survives the round trip through the persisted schema", () => {
    const payload = engineRejection("gob-1", 1, [], proposedTurn, spec);
    const parsed = ActionRejectedPayload.safeParse(payload);

    if (!parsed.success) throw new Error("expected the payload to parse");
    expect(parsed.data.promptVersion).toMatch(/\S/);
    expect(parsed.data.promptVersion).toBe(TACTICAL_PROMPT_VERSION);
  });
});
