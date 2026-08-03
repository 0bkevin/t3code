// @effect-diagnostics anyUnknownInErrorContext:off unsafeEffectTypeAssertion:off - mirrors alchemy/Drizzle's Postgres helper, which exposes framework-owned any requirements.
import * as MysqlClient from "@effect/sql-mysql2/MysqlClient";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { proxyChain } from "alchemy/Util/proxy-chain";
import type * as Cloudflare from "alchemy/Cloudflare";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import type { EffectMysql2Database } from "drizzle-orm/effect-mysql2";
import * as MysqlDrizzle from "drizzle-orm/effect-mysql2";
import type { EffectDrizzleMySqlConfig } from "drizzle-orm/mysql-core/effect/utils";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Open a Drizzle/MySQL database from a Cloudflare Hyperdrive binding using the
 * `drizzle-orm/effect-mysql2` integration.
 *
 * The MySQL counterpart of `alchemy/Drizzle`'s `Postgres` helper (which alchemy
 * does not ship for MySQL yet): the same deferred `proxyChain` handle over the
 * drizzle database, with the pool memoized per execution scope via
 * `makeExecutionMemo`, so deploy/plan-time evaluation never opens a
 * connection and each Worker invocation builds at most one pool.
 *
 * Connection options are Workers/Hyperdrive specific:
 * - discrete host/port/user/password fields instead of a URL, because
 *   `MysqlClient` ignores `poolConfig` on the URL path and mysql2 needs
 *   `disableEval: true` to run without eval() inside Workers;
 * - `disablePreparedStatements`, because Hyperdrive's MySQL proxy does not
 *   support `COM_STMT_PREPARE`.
 */
export const MySql = <TRelations extends AnyRelations = EmptyRelations>(
  hyperdrive: Cloudflare.Hyperdrive.ConnectClient,
  config?: EffectDrizzleMySqlConfig<TRelations>,
) =>
  Effect.map(
    makeExecutionMemo(
      Effect.gen(function* () {
        const mysqlCtx = yield* Layer.build(
          MysqlClient.layer({
            host: yield* hyperdrive.host,
            port: yield* hyperdrive.port,
            database: yield* hyperdrive.database,
            username: yield* hyperdrive.user,
            password: yield* hyperdrive.password,
            disablePreparedStatements: true,
            poolConfig: {
              disableEval: true,
            },
          }),
        );
        return yield* MysqlDrizzle.makeWithDefaults(config).pipe(Effect.provideContext(mysqlCtx));
      }),
    ),
    (db) =>
      proxyChain<
        EffectMysql2Database<TRelations> & {
          $client: MysqlClient.MysqlClient;
        }
      >(
        db as Effect.Effect<
          EffectMysql2Database<TRelations> & {
            $client: MysqlClient.MysqlClient;
          }
        >,
      ),
  );
