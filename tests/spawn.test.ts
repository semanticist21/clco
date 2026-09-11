import { describe, expect, test } from "bun:test"
import { buildModelPickerFrom } from "../src/spawn"

describe("buildModelPickerFrom", () => {
  test("pins the modelPicker lineup contract", () => {
    expect(buildModelPickerFrom([])).toBeNull()

    const list = [
      { id: "gpt-5.6-luna", name: "Luna 5.6" },
      { id: "claude-sonnet-5", name: "claude-sonnet-5" },
    ]
    const picker = buildModelPickerFrom(list)!
    // label only when display name differs from the id
    expect(picker.options[0]).toEqual({ model: "gpt-5.6-luna", label: "Luna 5.6" })
    expect(picker.options[1]).toEqual({ model: "claude-sonnet-5" })
    expect(picker.replaceBuiltInOptions).toBe(false)
  })

  test("caps the lineup at 200 entries", () => {
    const big = Array.from({ length: 250 }, (_, i) => ({ id: `m-${i}`, name: "" }))
    expect(buildModelPickerFrom(big)!.options).toHaveLength(200)
  })
})
