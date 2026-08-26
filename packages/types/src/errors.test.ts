import { describe, expect, test } from "bun:test";
import {
	BadRequestError,
	CheckpointNotFoundError,
	ConflictError,
	ForbiddenError,
	InvalidUpdateTokenError,
	LeaseExpiredError,
	NotFoundError,
	ProcellaError,
	ProjectNotFoundError,
	StackAlreadyExistsError,
	StackHasResourcesError,
	StackNotFoundError,
	UnauthorizedError,
	UpdateConflictError,
	UpdateNotFoundError,
} from "./errors.js";

describe("@procella/types errors", () => {
	// Inheritance is the non-trivial contract — status/code/message values are
	// restated in source and covered by the constructors themselves.
	describe("ProcellaError", () => {
		test("is an instance of Error", () => {
			const err = new ProcellaError("test", "CODE", 500);
			expect(err).toBeInstanceOf(Error);
		});
	});

	describe("NotFoundError", () => {
		test("is instance of ProcellaError", () => {
			expect(new NotFoundError("X", "1")).toBeInstanceOf(ProcellaError);
		});
	});

	describe("StackNotFoundError", () => {
		test("is instance of NotFoundError and ProcellaError", () => {
			const err = new StackNotFoundError("o", "p", "s");
			expect(err).toBeInstanceOf(NotFoundError);
			expect(err).toBeInstanceOf(ProcellaError);
		});
	});

	describe("StackAlreadyExistsError", () => {
		test("is instance of ConflictError", () => {
			expect(new StackAlreadyExistsError("o", "p", "s")).toBeInstanceOf(ConflictError);
		});
	});

	describe("LeaseExpiredError", () => {
		test("is instance of UnauthorizedError", () => {
			expect(new LeaseExpiredError()).toBeInstanceOf(UnauthorizedError);
		});
	});

	describe("inheritance", () => {
		test("all errors extend Error", () => {
			const errors = [
				new ProcellaError("x", "x", 500),
				new NotFoundError("x", "x"),
				new ConflictError("x"),
				new BadRequestError("x"),
				new UnauthorizedError(),
				new ForbiddenError(),
				new StackNotFoundError("o", "p", "s"),
				new StackAlreadyExistsError("o", "p", "s"),
				new StackHasResourcesError("o", "p", "s"),
				new UpdateNotFoundError("u"),
				new UpdateConflictError("x"),
				new LeaseExpiredError(),
				new InvalidUpdateTokenError(),
				new ProjectNotFoundError("o", "p"),
				new CheckpointNotFoundError("o", "p", "s"),
			];
			for (const err of errors) {
				expect(err).toBeInstanceOf(Error);
				expect(err).toBeInstanceOf(ProcellaError);
			}
		});
	});
});
