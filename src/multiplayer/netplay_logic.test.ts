import { describe, it, expect } from "vitest";
import { NetplayManager, hashGameId, canonicalizeGameId } from "../multiplayer.js";

describe("Netplay Logic Audit", () => {
  it("should produce stable hashes across game revisions", () => {
    const id1 = "Pokemon - FireRed Version (USA)";
    const id2 = "Pokemon - FireRed Version (USA) (Rev 1)";
    
    const hash1 = hashGameId(canonicalizeGameId(id1));
    const hash2 = hashGameId(canonicalizeGameId(id2));

    expect(hash1).toBe(hash2);
  });

  it("should correctly alias compatible Pokémon titles", () => {
    const mgr = new NetplayManager();
    const room1 = mgr.roomKeyFor("Pokemon - LeafGreen Version (USA)", "gba");
    const room2 = mgr.roomKeyFor("Pokemon - FireRed Version (USA)", "gba");

    expect(room1).toBe("pokemon_gen3_kanto");
    expect(room2).toBe("pokemon_gen3_kanto");
  });

  it("should validate username length", () => {
    const mgr = new NetplayManager();
    const longName = "This name is definitely way too long to be a real username in any reasonable system";
    const err = mgr.validateUsername(longName);
    expect(err).not.toBeNull();
  });
});
