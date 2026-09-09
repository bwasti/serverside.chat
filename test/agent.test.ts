import { expect, test } from "bun:test";
import { isConcreteWorkRequest, isTrivialSocialMessage, shouldGuideRespond } from "../src/agent";

test("social greetings are deterministically swallowed before model routing", () => {
  for (const message of ["hi", "Hi Alice", "@room-agent hello", "hey everyone!", "thanks", "cool"]) {
    expect(isTrivialSocialMessage(message)).toBe(true);
  }
  for (const message of ["make the button red", "what does worker.js do?", "hi, can you fix the page?"]) {
    expect(isTrivialSocialMessage(message)).toBe(false);
  }
});

test("explicit work requests are recognized without a probabilistic admission gate", () => {
  for (const message of ["fix it", "build a contact page", "can you remove that preview?", "investigate this bug", "please make the button red"]) {
    expect(isConcreteWorkRequest(message)).toBe(true);
  }
  for (const message of ["hi", "that is interesting", "what do you all think?"]) {
    expect(isConcreteWorkRequest(message)).toBe(false);
  }
});

test("the lobby guide admits product questions but not social or unrelated chat", () => {
  for (const message of ["how do I create a room?", "can I invite Alice", "what does tab do", "help", "SSH login?"]) {
    expect(shouldGuideRespond(message)).toBe(true);
  }
  for (const message of ["hi", "thanks everyone", "I like turtles", "great weather today"]) {
    expect(shouldGuideRespond(message)).toBe(false);
  }
});
