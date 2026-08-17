import { describe, expect, it } from "vitest";
import { ActionRejectedPayload } from "@ai-dm/schemas";
import { adapterRejection, engineRejection } from "./action-rejected.js";

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
