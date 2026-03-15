import { createRequestHandler } from "react-router";

// @ts-expect-error - virtual module from React Router build
import * as serverBuild from "virtual:react-router/server-build";

const requestHandler = createRequestHandler(serverBuild, process.env.NODE_ENV);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return requestHandler(request, { cloudflare: { env, ctx } });
  },
} satisfies ExportedHandler<Env>;
