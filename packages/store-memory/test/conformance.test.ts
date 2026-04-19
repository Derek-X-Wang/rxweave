import { runConformance } from "../../core/src/testing/conformance.js"
import { MemoryStore } from "../src/index.js"

runConformance({ name: "MemoryStore", layer: MemoryStore.Live })
