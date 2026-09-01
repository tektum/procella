import { protectedProcedure, router } from "../trpc.js";

export const authRouter = router({
	current: protectedProcedure.query(({ ctx }) => ({
		tenantId: ctx.caller.tenantId,
		roles: [...ctx.caller.roles],
	})),
});
