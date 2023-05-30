import { idb } from "@/common/db";
import { fromBuffer, toBuffer } from "@/common/utils";

export enum SudoswapV2PoolKind {
  ERC721_ETH,
  ERC721_ERC20,
  ERC1155_ETH,
  ERC1155_ERC20,
}

export type SudoswapV2Pool = {
  address: string;
  nft: string;
  token: string;
  bondingCurve: string;
  poolKind: SudoswapV2PoolKind;
  pairKind: number;
};

export const saveSudoswapV2Pool = async (sudoswapPool: SudoswapV2Pool) => {
  await idb.none(
    `
      INSERT INTO sudoswap_v2_pools (
        address,
        nft,
        token,
        bonding_curve,
        pool_kind,
        pair_kind
      ) VALUES (
        $/address/,
        $/nft/,
        $/token/,
        $/bondingCurve/,
        $/poolKind/,
        $/pairKind/
      )
      ON CONFLICT DO NOTHING
    `,
    {
      address: toBuffer(sudoswapPool.address),
      nft: toBuffer(sudoswapPool.nft),
      token: toBuffer(sudoswapPool.token),
      bondingCurve: toBuffer(sudoswapPool.bondingCurve),
      poolKind: sudoswapPool.poolKind,
      pairKind: sudoswapPool.pairKind,
    }
  );

  return sudoswapPool;
};

export const getSudoswapV2Pool = async (address: string): Promise<SudoswapV2Pool> => {
  const result = await idb.oneOrNone(
    `
      SELECT
        sudoswap_v2_pools.address,
        sudoswap_v2_pools.nft,
        sudoswap_v2_pools.token,
        sudoswap_v2_pools.bonding_curve,
        sudoswap_v2_pools.pool_kind,
        sudoswap_v2_pools.pair_kind
      FROM sudoswap_v2_pools
      WHERE sudoswap_v2_pools.address = $/address/
    `,
    { address: toBuffer(address) }
  );

  return {
    address,
    nft: fromBuffer(result.nft),
    token: fromBuffer(result.token),
    bondingCurve: fromBuffer(result.bonding_curve),
    poolKind: result.pool_kind,
    pairKind: result.pair_kind,
  };
};
