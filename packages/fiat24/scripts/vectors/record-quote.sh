#!/usr/bin/env bash
# Records the raw oracle inputs of vectors/chain/quote.json (SPEC §8.3, §11.1) with Foundry `cast`
# only (independent of viem and of the SDK): an anvil fork of Arbitrum One at the pinned block,
# set-up transactions by the §11.2 role holders, then `eth_call` of the real contract functions.
# Usage: packages/fiat24/scripts/vectors/record-quote.sh <upstream archive rpc> <out.json>
set -euo pipefail
UP=$1
OUT=$2
BLOCK=526365924
PORT=${PORT:-18645}
RPC=http://127.0.0.1:$PORT

anvil --fork-url "$UP" --fork-block-number $BLOCK --port $PORT --silent &
ANVIL=$!
trap 'kill $ANVIL' EXIT
for _ in $(seq 1 200); do cast block-number --rpc-url $RPC >/dev/null 2>&1 && break; sleep 0.3; done

ACCOUNT=0x133CAEecA096cA54889db71956c7f75862Ead7A0
DEPOSIT=0x4582f67698843Dfb6A9F195C0dDee05B0A8C973F
PRICELIST=0xafE30f42b1c28f7C0514e4A197407570D88044Ae
F24SALES=0x6b7188D78832208B33a557a82A9F46171c16f3f2
USDC=0xaf88d065e77c8cC2239327C5EDb3A432268e5831
USDC_MASTER_MINTER=0x8aFf09e2259cacbF4Fc4e3E53F3bf799EfEEab36
OPERATOR=0x1272c99bEFa7a70f935Edca81BF9a6E85C6D9D59
tok() {
  case $1 in
    USD24) echo 0xbE00f3db78688d9704BCb4e0a827aea3a9Cc0D62 ;;
    EUR24) echo 0x2c5d06f591D0d8cd43Ac232c2B654475a142c7DA ;;
    CHF24) echo 0xd41F1f0cf89fD239ca4c1F8E8ADA46345c86b0a4 ;;
    CNH24) echo 0x7288Ac74d211735374A23707D1518DCbbc0144fd ;;
  esac
}
CUR=(USD24 EUR24 CHF24 CNH24)
LIVE=350273
MINT_ID=734519
FRESH=0x10000000000000000000000000000000000000E7

num() { awk '{print $1}'; }
call() { cast call --rpc-url $RPC "$@" | num; }
as() { # as <from> <to> <sig> [args...]
  local from=$1; shift
  cast rpc --rpc-url $RPC anvil_impersonateAccount "$from" >/dev/null
  cast rpc --rpc-url $RPC anvil_setBalance "$from" 0xde0b6b3a7640000 >/dev/null
  cast send --rpc-url $RPC --unlocked --from "$from" "$@" >/dev/null
}
# eth_call from <from>; prints {"result":"<uint>"} or {"revert":"<data>"}
ethcall() {
  local from=$1; shift
  local out
  if out=$(cast call --rpc-url $RPC --from "$from" "$@" 2>&1); then
    printf '{"result":"%s"}' "$(echo "$out" | num)"
  else
    local data
    data=$(echo "$out" | grep -oE 'data: "0x[0-9a-fA-F]*"' | head -1 | grep -oE '0x[0-9a-fA-F]*' || true)
    printf '{"revert":"%s"}' "${data:-unknown}"
  fi
}

OWNER=$(cast call --rpc-url $RPC $ACCOUNT 'ownerOf(uint256)(address)' $LIVE)
DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Set-up (§11.2): client limit raised by OPERATOR so the input leg never hits the 30-day limit;
# each currency funded from the internal desk (ownerOf 9100..9105) holding the most of it at the
# fork block (internal senders skip the recipient limit, Fiat24Token.sol:194-196); deposit approved.
as $OPERATOR $ACCOUNT 'setClientLimit(uint256,uint256)' $LIVE 1000000000000000
FUNDING='[]'
for c in "${CUR[@]}"; do
  best=""; bestBal=0
  for id in 9100 9101 9102 9103 9104 9105; do
    holder=$(cast call --rpc-url $RPC $ACCOUNT 'ownerOf(uint256)(address)' $id)
    bal=$(call $(tok $c) 'balanceOf(address)(uint256)' $holder)
    if python3 -c "import sys; sys.exit(0 if $bal > $bestBal else 1)"; then best=$id; bestHolder=$holder; bestBal=$bal; fi
  done
  as $bestHolder $(tok $c) 'transfer(address,uint256)' $OWNER 10000000
  as $OWNER $(tok $c) 'approve(address,uint256)' $DEPOSIT 999999999999999999
  FUNDING=$(jq -c --arg c $c --arg id $best --arg h $bestHolder '. + [{currency:$c, desk:$id, holder:$h, amount:"10000000"}]' <<<"$FUNDING")
done

FX='[]'
spec_rows() { # side from to amount  (SPEC §8.3 table rows)
  cat <<'EOF'
exact-in EUR24 USD24 1000
exact-in EUR24 USD24 1
exact-in EUR24 USD24 12345
exact-in EUR24 CHF24 999
exact-in EUR24 CNH24 5000
exact-in CNH24 EUR24 98692
exact-in CNH24 USD24 7
exact-out EUR24 USD24 1000
exact-out EUR24 USD24 1
exact-out EUR24 CHF24 12345
exact-out CNH24 USD24 777
exact-out EUR24 CNH24 50000
EOF
}
grid_rows() {
  for side in exact-in exact-out; do
    for f in "${CUR[@]}"; do for t in "${CUR[@]}"; do
      [ "$f" = "$t" ] && continue
      bal=$(call $(tok $f) 'balanceOf(address)(uint256)' $OWNER)
      for a in 1 99 1000 123456 $bal; do echo "$side $f $t $a"; done
    done; done
  done
}
while read -r side f t a; do
  if [ "$side" = exact-in ]; then
    rate=$(call $DEPOSIT 'getExchangeRate(address,address)(uint256)' $(tok $f) $(tok $t))
    spread=$(call $DEPOSIT 'getSpread(address,address,bool)(uint256)' $(tok $f) $(tok $t) false)
    res=$(ethcall $OWNER $DEPOSIT 'moneyExchangeExactIn(address,address,uint256)(uint256)' $(tok $f) $(tok $t) $a)
  else
    rate=$(call $DEPOSIT 'getExchangeRate(address,address)(uint256)' $(tok $t) $(tok $f))
    spread=$(call $DEPOSIT 'getSpread(address,address,bool)(uint256)' $(tok $t) $(tok $f) true)
    res=$(ethcall $OWNER $DEPOSIT 'moneyExchangeExactOut(address,address,uint256)(uint256)' $(tok $f) $(tok $t) $a)
  fi
  bal=$(call $(tok $f) 'balanceOf(address)(uint256)' $OWNER)
  FX=$(jq -c --arg s $side --arg f $f --arg t $t --arg a $a --arg r $rate --arg p $spread --arg b $bal --argjson e "$res" \
    '. + [{side:$s, from:$f, to:$t, amount:$a, rate:$r, spread:$p, fromBalance:$b, ethCall:$e}]' <<<"$FX")
done < <(spec_rows; grid_rows)
MARKET_CLOSED=$(cast call --rpc-url $RPC $DEPOSIT 'marketClosed()(bool)')

# Top-up (§8.3): deposit unpaused by OPERATOR; USDC minted to the owner via the FiatToken
# masterMinter path; deposit approved for USDC.
as $OPERATOR $DEPOSIT 'unpause()'
as $USDC_MASTER_MINTER $USDC 'configureMinter(address,uint256)' $OWNER 1000000000000
as $OWNER $USDC 'mint(address,uint256)' $OWNER 1000000000000
as $OWNER $USDC 'approve(address,uint256)' $DEPOSIT 1000000000000
TOKENID=$(call $ACCOUNT 'historicOwnership(address)(uint256)' $OWNER)
USDCRATE=$(call $DEPOSIT 'exchangeRates(address,address)(uint256)' $USDC $(tok USD24))
TOPUP='[]'
for amt in 5000000 100000000 123456789; do
  fee=$(call $DEPOSIT 'getFee(uint256,uint256)(uint256)' $TOKENID $amt)
  for c in "${CUR[@]}"; do
    rate=$(call $DEPOSIT 'getExchangeRate(address,address)(uint256)' $(tok USD24) $(tok $c))
    spread=$(call $DEPOSIT 'getSpread(address,address,bool)(uint256)' $(tok USD24) $(tok $c) false)
    res=$(ethcall $OWNER $DEPOSIT 'depositTokenViaUsdc(address,address,uint256)(uint256)' $USDC $(tok $c) $amt)
    TOPUP=$(jq -c --arg o $c --arg a $amt --arg f $fee --arg u $USDCRATE --arg r $rate --arg p $spread --argjson e "$res" \
      '. + [{output:$o, usdcAmount:$a, fee:$f, usdcRate:$u, rate:$r, spread:$p, ethCall:$e}]' <<<"$TOPUP")
  done
done
PROVIDER=$(call $ACCOUNT 'walletProvider(uint256)(uint256)' $TOKENID)

# Mint price (§8.3): the boundary of mintByClientWithETH from a fresh address (no NFT, no
# historicOwnership): value V succeeds, V-1 reverts. V is the candidate under test; the oracle is the
# success/revert boundary of the contract itself.
PRICE=$(call $PRICELIST 'getPrice(uint256)(uint256)' $MINT_ID)
QUOTE=$(call $F24SALES 'quotePerEther()(uint256)')
V=$(python3 -c "p=$PRICE; q=$QUOTE; print((p//q)*10**18 if q<p else 10**18//(q//p))")
cast rpc --rpc-url $RPC anvil_setBalance $FRESH 0x56bc75e2d63100000 >/dev/null
OK=$(ethcall $FRESH $ACCOUNT 'mintByClientWithETH(uint256)' $MINT_ID --value $V)
LOW=$(ethcall $FRESH $ACCOUNT 'mintByClientWithETH(uint256)' $MINT_ID --value $((V-1)))

jq -n --arg date "$DATE" --arg up "$UP" --arg block $BLOCK --arg owner $OWNER --arg mc "$MARKET_CLOSED" \
  --argjson funding "$FUNDING" --argjson fx "$FX" --arg tokenId $TOKENID --arg provider $PROVIDER --argjson topup "$TOPUP" \
  --arg mintId $MINT_ID --arg price $PRICE --arg quote $QUOTE --arg v $V --argjson ok "$OK" --argjson low "$LOW" '{
  source: ("recorded " + $date + " eth_call on anvil 1.10.0 --fork-url " + $up + " --fork-block-number " + $block + " (cast 1.10.0, packages/fiat24/scripts/vectors/record-quote.sh)"),
  block: $block,
  exchange: { sender: $owner, senderTokenId: "350273", marketClosed: ($mc == "true"),
    setup: { clientLimit: "1000000000000000", funding: $funding, depositAllowance: "999999999999999999" },
    cases: $fx },
  topUp: { sender: $owner, tokenId: $tokenId, walletProvider: $provider, setup: "deposit unpaused by OPERATOR; USDC minted via masterMinter", cases: $topup },
  mint: { sender: "0x10000000000000000000000000000000000000E7", tokenId: $mintId, priceF24: $price, quotePerEther: $quote,
    value: $v, atValue: $ok, atValueMinusOne: $low }
}' > "$OUT"
echo "wrote $OUT"
