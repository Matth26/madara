import { ApiPromise, Keyring } from "@polkadot/api";
import { ApiTypes, SubmittableExtrinsic } from "@polkadot/api/types";
import { EventRecord } from "@polkadot/types/interfaces";
import { RegistryError } from "@polkadot/types/types";
import { ChildProcess } from "child_process";

import { createAndFinalizeBlock } from "./block";
import { DEBUG_MODE, SPAWNING_TIME } from "./constants";
import {
  RuntimeChain,
  startMadaraDevNode,
  startMadaraForkedNode,
} from "./dev-node";
import { providePolkadotApi } from "./providers";
import { extractError, ExtrinsicCreation } from "./substrate-rpc";

import type { BlockHash } from "@polkadot/types/interfaces/chain/types";
import { KeyringPair } from "@polkadot/keyring/types";
const debug = require("debug")("test:setup");

export interface BlockCreation {
  parentHash?: string;
  finalize?: boolean;
}

export interface BlockCreationResponse<
  ApiType extends ApiTypes,
  Call extends
    | SubmittableExtrinsic<ApiType>
    | string
    | (SubmittableExtrinsic<ApiType> | string)[]
> {
  block: {
    duration: number;
    hash: string;
  };
  result: Call extends (string | SubmittableExtrinsic<ApiType>)[]
    ? ExtrinsicCreation[]
    : ExtrinsicCreation;
}

export interface DevTestContext {
  alice: KeyringPair;
  createPolkadotApi: () => Promise<ApiPromise>;

  createBlock<
    ApiType extends ApiTypes,
    Call extends
      | SubmittableExtrinsic<ApiType>
      | Promise<SubmittableExtrinsic<ApiType>>
      | string
      | Promise<string>,
    Calls extends Call | Call[]
  >(
    transactions?: Calls,
    options?: BlockCreation
  ): Promise<
    BlockCreationResponse<
      ApiType,
      Calls extends Call[] ? Awaited<Call>[] : Awaited<Call>
    >
  >;

  // We also provided singleton providers for simplicity
  polkadotApi: ApiPromise;
  rpcPort: number;
}

interface InternalDevTestContext extends DevTestContext {
  _polkadotApis: ApiPromise[];
}

export function describeDevMadara(
  title: string,
  cb: (context: DevTestContext) => void,
  runtime: RuntimeChain = "madara",
  withWasm?: boolean,
  forkedMode?: boolean
) {
  describe(title, function () {
    // Set timeout to 50000 for all tests.
    this.timeout(50000);

    // The context is initialized empty to allow passing a reference
    // and to be filled once the node information is retrieved
    let context: InternalDevTestContext = {} as InternalDevTestContext;

    // The currently running node for this describe
    let madaraProcess: ChildProcess;

    // Making sure the Madara node has started
    before("Starting Madara Test Node", async function () {
      this.timeout(SPAWNING_TIME);
      const init = forkedMode
        ? await startMadaraForkedNode(9933, 9944)
        : !DEBUG_MODE
        ? await startMadaraDevNode(withWasm, runtime)
        : {
            runningNode: null,
            p2pPort: 19931,
            wsPort: 19933,
            rpcPort: 19932,
          };
      madaraProcess = init.runningNode;
      context.rpcPort = init.rpcPort;

      // Context is given prior to this assignment, so doing
      // context = init.context will fail because it replace the variable;

      context._polkadotApis = [];
      madaraProcess = init.runningNode;

      context.createPolkadotApi = async () => {
        const apiPromise = await providePolkadotApi(init.wsPort);
        // We keep track of the polkadotApis to close them at the end of the test
        context._polkadotApis.push(apiPromise);
        await apiPromise.isReady;
        // Necessary hack to allow polkadotApi to finish its internal metadata loading
        // apiPromise.isReady unfortunately doesn't wait for those properly
        await new Promise((resolve) => {
          setTimeout(resolve, 1000);
        });

        return apiPromise;
      };

      context.polkadotApi = await context.createPolkadotApi();

      const keyringSr25519 = new Keyring({ type: "sr25519" });
      context.alice = keyringSr25519.addFromUri("//Alice");

      context.createBlock = async <
        ApiType extends ApiTypes,
        Call extends
          | SubmittableExtrinsic<ApiType>
          | Promise<SubmittableExtrinsic<ApiType>>
          | string
          | Promise<string>,
        Calls extends Call | Call[]
      >(
        transactions?: Calls,
        options: BlockCreation = {}
      ) => {
        const results: (
          | { type: "eth"; hash: string }
          | { type: "sub"; hash: string }
        )[] = [];
        const txs =
          transactions == undefined
            ? []
            : Array.isArray(transactions)
            ? transactions
            : [transactions];
        for await (const call of txs) {
          console.log(call.isSigned);
          if (typeof call == "string") {
            // Starknet
            // results.push({
            //   type: "eth",
            //   hash: (
            //     await customWeb3Request(
            //       context.web3,
            //       "eth_sendRawTransaction",
            //       [call]
            //     )
            //   ).result,
            // });
          } else if (call.isSigned) {
            const tx = context.polkadotApi.tx(call);
            debug(
              `- Signed: ${tx.method.section}.${tx.method.method}(${tx.args
                .map((d) => d.toHuman())
                .join("; ")}) [ nonce: ${tx.nonce}]`
            );
            results.push({
              type: "sub",
              hash: (await call.send()).toString(),
            });
          } else {
            // Bug WASM not initialized
            await context.polkadotApi.isReady;
            const keyringSr25519 = new Keyring({ type: "sr25519" });
            const alice = keyringSr25519.addFromUri("//Alice");

            const tx = context.polkadotApi.tx(call);
            debug(
              `- Unsigned: ${tx.method.section}.${tx.method.method}(${tx.args
                .map((d) => d.toHuman())
                .join("; ")}) [ nonce: ${tx.nonce}]`
            );
            results.push({
              type: "sub",
              hash: (await call.signAndSend(alice)).toString(),
            });
          }
        }

        const { parentHash, finalize } = options;
        const blockResult = await createAndFinalizeBlock(
          context.polkadotApi,
          parentHash,
          finalize
        );

        // No need to extract events if no transactions
        if (results.length == 0) {
          return {
            block: blockResult,
            result: null,
          };
        }

        // We retrieve the events for that block
        const allRecords: EventRecord[] = (await (
          await context.polkadotApi.at(blockResult.hash)
        ).query.system.events()) as any;
        // We retrieve the block (including the extrinsics)
        const blockData = await context.polkadotApi.rpc.chain.getBlock(
          blockResult.hash
        );

        const result: ExtrinsicCreation[] = results.map((result) => {
          const extrinsicIndex =
            result.type == "eth"
              ? allRecords
                  .find(
                    ({ phase, event: { section, method, data } }) =>
                      phase.isApplyExtrinsic &&
                      section == "ethereum" &&
                      method == "Executed" &&
                      data[2].toString() == result.hash
                  )
                  ?.phase?.asApplyExtrinsic?.toNumber()
              : blockData.block.extrinsics.findIndex(
                  (ext) => ext.hash.toHex() == result.hash
                );
          // We retrieve the events associated with the extrinsic
          const events = allRecords.filter(
            ({ phase }) =>
              phase.isApplyExtrinsic &&
              phase.asApplyExtrinsic.toNumber() === extrinsicIndex
          );
          const failure = extractError(events);
          return {
            extrinsic:
              extrinsicIndex >= 0
                ? blockData.block.extrinsics[extrinsicIndex]
                : null,
            events,
            error:
              failure &&
              ((failure.isModule &&
                context.polkadotApi.registry.findMetaError(failure.asModule)) ||
                ({ name: failure.toString() } as RegistryError)),
            successful: extrinsicIndex !== undefined && !failure,
            hash: result.hash,
          };
        });

        // Adds extra time to avoid empty transaction when querying it
        if (results.find((r) => r.type == "eth")) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        return {
          block: blockResult,
          result: Array.isArray(transactions) ? result : (result[0] as any),
        };
      };

      debug(`Setup ready for ${this.currentTest.title}`);
    });

    after(async function () {
      await Promise.all(context._polkadotApis.map((p) => p.disconnect()));

      if (madaraProcess) {
        await new Promise((resolve) => {
          madaraProcess.once("exit", resolve);
          madaraProcess.kill();
          madaraProcess = null;
        });
      }
    });

    cb(context);
  });
}
