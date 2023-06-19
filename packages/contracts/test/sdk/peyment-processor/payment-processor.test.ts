import { Contract } from "@ethersproject/contracts";
import { parseEther } from "@ethersproject/units";
import * as Common from "@reservoir0x/sdk/src/common";
import * as PaymentProcessor from "@reservoir0x/sdk/src/payment-processor";
import { Builders } from "@reservoir0x/sdk/src/seaport-base";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { hexZeroPad, splitSignature } from "@ethersproject/bytes";
import { constants } from "ethers";
import { keccak256, solidityKeccak256 } from "ethers/lib/utils";

import {
  bn,
  getChainId,
  getCurrentTimestamp,
  reset,
  setupNFTs,
  setupTokens,
} from "../../utils";
import { defaultAbiCoder } from "@ethersproject/abi";
import { _TypedDataEncoder } from "@ethersproject/hash";
import {
    EIP712_DOMAIN,
    EIP712_SALE_APPROVAL_TYPES,
    EIP712_OFFER_APPROVAL_TYPES,
    // EIP712_SELL_OFFER_TYPES,
    // EIP712_ORACLE_OFFER_TYPES
} from "@reservoir0x/sdk/src/payment-processor/order";

describe("PaymentProcessor", () => {
  const chainId = getChainId();

  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let ted: SignerWithAddress;
  let carol: SignerWithAddress;

  let erc20: Contract;
  let erc721: Contract;

  beforeEach(async () => {
    [deployer, alice, bob, ted, carol] = await ethers.getSigners();

    ({ erc20 } = await setupTokens(deployer));
    ({ erc721 } = await setupNFTs(deployer));
  });

  afterEach(reset);

  it("buySignleListing", async () => {
    const buyer = alice;
    const seller = bob;
    const price = parseEther("1");
    const soldTokenId = 1;

    const oracle = buyer;

    // Mint erc721 to seller
    await erc721.connect(seller).mint(soldTokenId);

    const nft = new Common.Helpers.Erc721(ethers.provider, erc721.address);

    // Approve the exchange
    await nft.approve(seller, PaymentProcessor.Addresses.PaymentProcessor[chainId]);

    const exchange = new PaymentProcessor.Exchange(chainId);

    // const nonce = await exchange.contract.connect(lender).nonces(lender.address);
    const blockTime = await getCurrentTimestamp(ethers.provider);
    // const listing = {
    //     protocol: 1,
    //     sellerAcceptedOffer: true,
    //     marketplace: constants.AddressZero,
    //     marketplaceFeeNumerator: "0",
    //     maxRoyaltyFeeNumerator: "0",
    //     privateBuyer: constants.AddressZero,
    //     seller: seller.address,
    //     tokenAddress: erc721.address,
    //     tokenId: soldTokenId,
    //     amount: "1",
    //     listingMinPrice: price,
    //     listingExpiration: (blockTime + 60 * 60).toString(),
    //     listingNonce: "0",
    //     masterNonce: "0",
    //     paymentCoin: constants.AddressZero,
    // }

    const listing = {
        protocol: 0,
        sellerAcceptedOffer: false,
        marketplace: constants.AddressZero,
        marketplaceFeeNumerator: "0",
        maxRoyaltyFeeNumerator: "0",
        privateBuyer: constants.AddressZero,
        seller: seller.address,
        tokenAddress: erc721.address,
        tokenId: soldTokenId,
        amount: "1",
        minPrice: price,
        expiration: (blockTime + 60 * 60).toString(),
        nonce: "0",
        masterNonce: "0",
        coin: constants.AddressZero,
    }

    const fnSign = "SaleApproval(uint8 protocol,bool sellerAcceptedOffer,address marketplace,uint256 marketplaceFeeNumerator,uint256 maxRoyaltyFeeNumerator,address privateBuyer,address seller,address tokenAddress,uint256 tokenId,uint256 amount,uint256 minPrice,uint256 expiration,uint256 nonce,uint256 masterNonce,address coin)";
    const SaleApprovalTypeHash = solidityKeccak256(["string"], [fnSign]);

    console.log('typeHash', SaleApprovalTypeHash)
    // sign SaleApproval
    const hash = _TypedDataEncoder.hashStruct("SaleApproval", EIP712_SALE_APPROVAL_TYPES, listing);
    console.log("structHash", hash)
    const listingSignature = await seller._signTypedData(EIP712_DOMAIN(chainId), EIP712_SALE_APPROVAL_TYPES, listing);
    console.log("listingSignature", listingSignature, EIP712_DOMAIN(chainId))

    // const offer = {
    //     protocol: 1,
    //     marketplace: listing.marketplace,
    //     marketplaceFeeNumerator: listing.marketplaceFeeNumerator,
    //     delegatedPurchaser: constants.AddressZero,
    //     buyer: buyer.address,
    //     tokenAddress: listing.tokenAddress,
    //     tokenId: listing.tokenId,
    //     amount: listing.amount,
    //     offerPrice: listing.listingMinPrice,
    //     offerExpiration: listing.listingExpiration,
    //     offerNonce: listing.listingNonce,
    //     masterNonce: "0",
    //     paymentCoin: listing.paymentCoin,
    // }

    const offer = {
        protocol: listing.protocol,
        marketplace: listing.marketplace,
        marketplaceFeeNumerator: listing.marketplaceFeeNumerator,

        delegatedPurchaser: constants.AddressZero,
        buyer: buyer.address,
        tokenAddress: listing.tokenAddress,
        tokenId: listing.tokenId,
        amount: listing.amount,

        price: listing.minPrice,
        expiration: listing.expiration,
        nonce: listing.nonce,
        masterNonce: "0",
        coin: constants.AddressZero
    }

  

    // sign SaleApproval
    console.log("SaleApproval")
    const offerHash = _TypedDataEncoder.hashStruct("OfferApproval", EIP712_OFFER_APPROVAL_TYPES, offer);
    console.log("offerHash", offerHash)
    // return;
    const offerSignature = await buyer._signTypedData(EIP712_DOMAIN(chainId), EIP712_OFFER_APPROVAL_TYPES, offer);
    console.log("offerSignature", splitSignature(offerSignature))

    const matchedOrderListing: PaymentProcessor.Types.MatchOrder = {
        sellerAcceptedOffer: listing.sellerAcceptedOffer,
        collectionLevelOffer: false,
        protocol: listing.protocol,
        paymentCoin: listing.coin,
        tokenAddress: listing.tokenAddress,
        seller: listing.seller,
        privateBuyer: listing.privateBuyer,

        buyer: buyer.address,
        offerPrice: listing.minPrice,
        offerNonce: listing.nonce,

        delegatedPurchaser: constants.AddressZero,
        marketplace: listing.marketplace,
        marketplaceFeeNumerator: listing.marketplaceFeeNumerator,
        maxRoyaltyFeeNumerator: listing.maxRoyaltyFeeNumerator,

        listingNonce: listing.nonce,
        listingMinPrice: listing.minPrice,
        listingExpiration: listing.expiration,
        offerExpiration: listing.expiration,
        tokenId: listing.tokenId,
        amount: listing.amount,

        sellerMasterNonce: "0",
        buyerMasterNonce: "0",

        listingSignature: listingSignature,
        offerSignature: offerSignature
    }

    console.log('matchedOrderListing', matchedOrderListing)
    // const tx = await exchange.contract.connect(buyer).buySingleListing(
    //     matchedOrderListing,
    //     splitSignature(listingSignature),
    //     splitSignature(offerSignature),
    //     {
    //         value: price,
    //         gasLimit: 30000000
    //     }
    // )

    const order = new PaymentProcessor.Order(chainId, matchedOrderListing);
    order.checkSignature();
    await exchange.fillOrder(buyer, order);
    // oracle sign
    // const blockNumber = await ethers.provider.getBlockNumber();
    // const oracleSignature = await oracle._signTypedData(
    //     EIP712_DOMAIN(chainId),
    //     EIP712_ORACLE_OFFER_TYPES,
    //     {
    //         hash,
    //         blockNumber
    //     }
    // )
    // blenderDeployer.
    // const signature = `${offerSignature}${oracleSignature.slice(2)}` + defaultAbiCoder.encode([
    //     "uint256"
    // ], [
    //     blockNumber
    // ]).slice(2);


    // const loanAmount = price
    // const collateralTokenId = soldTokenId;

    // const txData = await exchange.contract.connect(seller).populateTransaction.borrow(
    //     loanOffer,
    //     signature,
    //     loanAmount,
    //     collateralTokenId
    // );

    // const result = await seller.sendTransaction({
    //     ...txData,
    //     gasLimit: 10000000
    // });

    // let lienId = '';
    // let lien = null
    // const recepient = await result.wait();
    // const block = await ethers.provider.getBlock(recepient.blockNumber);
    // for(const log of recepient.logs) {
    //     try {
    //         const parsedLog = exchange.contract.interface.parseLog(log);
    //         if (parsedLog.name === "LoanOfferTaken") {
    //             const args = parsedLog.args;
    //             lienId = parsedLog.args.lienId.toString();
    //             // console.log("args", args)
    //             lien = {
    //                 lender: args.lender,
    //                 borrower: args.borrower,
    //                 collection: args.collection,
    //                 tokenId: args.tokenId,
    //                 amount: args.loanAmount,
    //                 rate: args.rate,
    //                 auctionStartBlock: 0,
    //                 startTime: block.timestamp,
    //                 auctionDuration: args.auctionDuration,
    //             }     
    //         }
    //     } catch {
    //     }
    // }

    const borrower = seller;

    // const sellOffer = {
    //     borrower: borrower.address,
    //     lienId,
    //     price: price.toString(),
    //     expirationTime: (blockTime + 60 * 60).toString(),
    //     salt: "265875887785256855606558013756560384533",
    //     oracle: oracle.address,
    //     fees: [],
    //     nonce: nonce.toString()
    // }

    // console.log("lien", lien)
     // sign Lender Offer
    //  const sellOfferHash = _TypedDataEncoder.hashStruct("SellOffer", EIP712_SELL_OFFER_TYPES, sellOffer);
    //  console.log("sellOfferHash", sellOfferHash)
    //  const sellOfferSignature =  await borrower._signTypedData(EIP712_DOMAIN(chainId), EIP712_SELL_OFFER_TYPES, sellOffer);
 
     // oracle sign
    //  const sellOracleSignature = await oracle._signTypedData(
    //      EIP712_DOMAIN(chainId),
    //      EIP712_ORACLE_OFFER_TYPES,
    //      {
    //         hash: sellOfferHash,
    //         blockNumber
    //      }
    //  )
    //  console.log({
    //     sellOfferSignature: splitSignature(sellOfferSignature),
    //     sellOracleSignature,
    //     blockNumber
    //  })
    //  const sellSignature = `${sellOfferSignature}${sellOracleSignature.slice(2)}` + defaultAbiCoder.encode([
    //      "uint256"
    //  ], [
    //     blockNumber
    //  ]).slice(2);

    // const order = new Blend.Order(chainId, {
    //     ...sellOffer,
    //     signature: sellSignature
    // });

    // order.checkSignature();
    // order.checkFillability(ethers.provider);


    // await exchange.fillOrder(carol, order, lien!)
    // const sellTxData = await exchange.contract.connect(carol).populateTransaction.buyLocked(
    //     lien,
    //     sellOffer,
    //     sellSignature
    // );
    
    // await carol.sendTransaction({
    //     ...sellTxData,
    //     gasLimit: 10000000
    // });
 
    // console.log("result", recepient)
    // // Build sell order
    // const sellOrder = builder.build({
    //   side: "sell",
    //   tokenKind: "erc721",
    //   offerer: seller.address,
    //   contract: erc721.address,
    //   tokenId: soldTokenId,
    //   paymentToken: Common.Addresses.Eth[chainId],
    //   price,
    //   counter: 0,
    //   startTime: await getCurrentTimestamp(ethers.provider),
    //   endTime: (await getCurrentTimestamp(ethers.provider)) + 60,
    // }, SeaportV11.Order);

    // // Sign the order
    // await sellOrder.sign(seller);

    // await sellOrder.checkFillability(ethers.provider);

    // // Create matching params
    // const matchParams = sellOrder.buildMatching();

    // const buyerEthBalanceBefore = await ethers.provider.getBalance(
    //   buyer.address
    // );
    // const sellerEthBalanceBefore = await ethers.provider.getBalance(
    //   seller.address
    // );
    // const ownerBefore = await nft.getOwner(soldTokenId);

    // expect(ownerBefore).to.eq(seller.address);

    // // Match orders
    // await exchange.fillOrder(buyer, sellOrder, matchParams, {
    //   source: "reservoir.market",
    // });

    // const buyerEthBalanceAfter = await ethers.provider.getBalance(
    //   buyer.address
    // );
    // const sellerEthBalanceAfter = await ethers.provider.getBalance(
    //   seller.address
    // );
    const ownerAfter = await nft.getOwner(soldTokenId);

    // expect(buyerEthBalanceBefore.sub(buyerEthBalanceAfter)).to.be.gt(price);
    // expect(sellerEthBalanceAfter).to.eq(sellerEthBalanceBefore.add(price));
    expect(ownerAfter).to.eq(buyer.address);
  });

});