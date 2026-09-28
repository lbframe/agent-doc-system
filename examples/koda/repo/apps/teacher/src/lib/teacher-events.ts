import { LESSON_PUBLISHED } from "@koda/lesson-canon";

// Teacher publishes the canonical lesson artifact. This is a DISTINCT contract
// from the reserved notification subject koda.flow.lesson.available.
export function publishLesson(lesson: unknown) {
  return { subject: LESSON_PUBLISHED, payload: lesson };
}
