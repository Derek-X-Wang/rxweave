import { runConformance } from "@rxweave/core/testing"
import { MemoryStore } from "../src/index.js"

runConformance({ name: "MemoryStore", layer: MemoryStore.Live })
