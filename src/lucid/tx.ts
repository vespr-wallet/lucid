import { C, Core } from "../core/mod.ts";
import {
  Address,
  Assets,
  CertificateValidator,
  Configuration,
  Datum,
  Json,
  Label,
  Lovelace,
  MintingPolicy,
  OutputData,
  PaymentKeyHash,
  PoolId,
  PoolParams,
  Redeemer,
  RewardAddress,
  SpendingValidator,
  StakeKeyHash,
  UnixTime,
  UTxO,
  WithdrawalValidator,
} from "../types/mod.ts";
import {
  assetsToValue,
  fromHex,
  networkToId,
  toHex,
  toScriptRef,
  utxoToCore,
  valueToAssets,
  chunk,
} from "../utils/mod.ts";
import { applyDoubleCborEncoding } from "../utils/utils.ts";
import { Lucid } from "./lucid.ts";
import { defaultConfig } from "./tx_config.ts";
import { TxComplete } from "./tx_complete.ts";

export class Tx {
  txBuilder: Core.TransactionBuilder;
  /** Stores the tx instructions, which get executed after calling .complete() */
  private tasks: ((that: Tx) => unknown)[];
  private lucid: Lucid;
  configuration = defaultConfig;

  constructor(lucid: Lucid) {
    this.lucid = lucid;
    this.txBuilder = C.TransactionBuilder.new(this.lucid.txBuilderConfig);
    this.tasks = [];
  }

  /** Read data from utxos. These utxos are only referenced and not spent. */
  readFrom(utxos: UTxO[]): Tx {
    this.tasks.push(async (that) => {
      for (const utxo of utxos) {
        if (utxo.datumHash) {
          utxo.datum = await that.lucid.datumOf(utxo);
          // Add datum to witness set, so it can be read from validators
          const plutusData = C.PlutusData.from_bytes(fromHex(utxo.datum!));
          that.txBuilder.add_plutus_data(plutusData);
        }
        const coreUtxo = utxoToCore(utxo);
        that.txBuilder.add_reference_input(coreUtxo);
      }
    });
    return this;
  }

  /**
   * Customize the transaction builder
   */
  config(newConfig: Partial<Configuration>) {
    this.configuration = { ...this.configuration, ...newConfig };
    return this;
  }

  /**
   * A public key or native script input.
   * With redeemer it's a plutus script input.
   */
  collectFrom(utxos: UTxO[], redeemer?: Redeemer): Tx {
    this.tasks.push(async (that) => {
      for (const utxo of utxos) {
        if (utxo.datumHash && !utxo.datum) {
          utxo.datum = await that.lucid.datumOf(utxo);
        }
        const coreUtxo = utxoToCore(utxo);
        that.txBuilder.add_input(
          coreUtxo,
          (redeemer as undefined) &&
            C.ScriptWitness.new_plutus_witness(
              C.PlutusWitness.new(
                C.PlutusData.from_bytes(fromHex(redeemer!)),
                utxo.datumHash && utxo.datum
                  ? C.PlutusData.from_bytes(fromHex(utxo.datum!))
                  : undefined,
                undefined
              )
            )
        );
      }
    });
    return this;
  }

  /**
   * All assets should be of the same policy id.
   * You can chain mintAssets functions together if you need to mint assets with different policy ids.
   * If the plutus script doesn't need a redeemer, you still need to specifiy the empty redeemer.
   */
  mintAssets(assets: Assets, redeemer?: Redeemer): Tx {
    this.tasks.push((that) => {
      const units = Object.keys(assets);
      const policyId = units[0].slice(0, 56);
      const mintAssets = C.MintAssets.new();
      units.forEach((unit) => {
        if (unit.slice(0, 56) !== policyId) {
          throw new Error(
            "Only one Policy Id allowed. You can chain multiple mintAssets functions together if you need to mint assets with different Policy Ids."
          );
        }
        mintAssets.insert(
          C.AssetName.new(fromHex(unit.slice(56))),
          C.Int.from_str(assets[unit].toString())
        );
      });
      const scriptHash = C.ScriptHash.from_bytes(fromHex(policyId));
      that.txBuilder.add_mint(
        scriptHash,
        mintAssets,
        redeemer
          ? C.ScriptWitness.new_plutus_witness(
              C.PlutusWitness.new(
                C.PlutusData.from_bytes(fromHex(redeemer!)),
                undefined,
                undefined
              )
            )
          : undefined
      );
    });
    return this;
  }

  /** Pay to a public key or native script address. */
  payToAddress(address: Address, assets: Assets): Tx {
    this.tasks.push((that) => {
      let output = C.TransactionOutput.new(
        addressFromWithNetworkCheck(address, that.lucid),
        assetsToValue(assets)
      );
      const minAda = that.lucid.utils.getMinAdaForOutput(output);
      assets.lovelace = assets.lovelace > minAda ? assets.lovelace : minAda;
      output = C.TransactionOutput.new(
        addressFromWithNetworkCheck(address, that.lucid),
        assetsToValue(assets)
      );
      that.txBuilder.add_output(output);
    });
    return this;
  }

  /** Pay to a public key or native script address with datum or scriptRef. */
  payToAddressWithData(
    address: Address,
    outputData: Datum | OutputData,
    assets: Assets
  ): Tx {
    this.tasks.push((that) => {
      if (typeof outputData === "string") {
        outputData = { asHash: outputData };
      }

      if (
        [outputData.hash, outputData.asHash, outputData.inline].filter((b) => b)
          .length > 1
      ) {
        throw new Error(
          "Not allowed to set hash, asHash and inline at the same time."
        );
      }
      const createOutput = (_assets) => {
        const output = C.TransactionOutput.new(
          addressFromWithNetworkCheck(address, that.lucid),
          assetsToValue(_assets)
        );

        if (outputData.hash) {
          output.set_datum(
            C.Datum.new_data_hash(C.DataHash.from_hex(outputData.hash))
          );
        } else if (outputData.asHash) {
          const plutusData = C.PlutusData.from_bytes(
            fromHex(outputData.asHash)
          );
          output.set_datum(
            C.Datum.new_data_hash(C.hash_plutus_data(plutusData))
          );
          that.txBuilder.add_plutus_data(plutusData);
        } else if (outputData.inline) {
          const plutusData = C.PlutusData.from_bytes(
            fromHex(outputData.inline)
          );
          output.set_datum(C.Datum.new_data(C.Data.new(plutusData)));
        }

        const script = outputData.scriptRef;
        if (script) {
          output.set_script_ref(toScriptRef(script));
        }
        return output;
      };
      let output = createOutput(assets);
      const minAda = this.lucid.utils.getMinAdaForOutput(output);
      assets.lovelace = assets.lovelace > minAda ? assets.lovelace : minAda;
      output = createOutput(assets);
      that.txBuilder.add_output(output);
    });
    return this;
  }

  /** Pay to a plutus script address with datum or scriptRef. */
  payToContract(
    address: Address,
    outputData: Datum | OutputData,
    assets: Assets
  ): Tx {
    if (typeof outputData === "string") {
      outputData = { asHash: outputData };
    }

    if (!(outputData.hash || outputData.asHash || outputData.inline)) {
      throw new Error(
        "No datum set. Script output becomes unspendable without datum."
      );
    }
    return this.payToAddressWithData(address, outputData, assets);
  }

  /** Delegate to a stake pool. */
  delegateTo(
    rewardAddress: RewardAddress,
    poolId: PoolId,
    redeemer?: Redeemer
  ): Tx {
    this.tasks.push((that) => {
      const addressDetails = that.lucid.utils.getAddressDetails(rewardAddress);

      if (addressDetails.type !== "Reward" || !addressDetails.stakeCredential) {
        throw new Error("Not a reward address provided.");
      }
      const credential =
        addressDetails.stakeCredential.type === "Key"
          ? C.StakeCredential.from_keyhash(
              C.Ed25519KeyHash.from_bytes(
                fromHex(addressDetails.stakeCredential.hash)
              )
            )
          : C.StakeCredential.from_scripthash(
              C.ScriptHash.from_bytes(
                fromHex(addressDetails.stakeCredential.hash)
              )
            );

      that.txBuilder.add_certificate(
        C.Certificate.new_stake_delegation(
          C.StakeDelegation.new(
            credential,
            C.Ed25519KeyHash.from_bech32(poolId)
          )
        ),
        redeemer
          ? C.ScriptWitness.new_plutus_witness(
              C.PlutusWitness.new(
                C.PlutusData.from_bytes(fromHex(redeemer!)),
                undefined,
                undefined
              )
            )
          : undefined
      );
    });
    return this;
  }

  /** Register a reward address in order to delegate to a pool and receive rewards. */
  registerStake(rewardAddress: RewardAddress): Tx {
    this.tasks.push((that) => {
      const addressDetails = that.lucid.utils.getAddressDetails(rewardAddress);

      if (addressDetails.type !== "Reward" || !addressDetails.stakeCredential) {
        throw new Error("Not a reward address provided.");
      }
      const credential =
        addressDetails.stakeCredential.type === "Key"
          ? C.StakeCredential.from_keyhash(
              C.Ed25519KeyHash.from_bytes(
                fromHex(addressDetails.stakeCredential.hash)
              )
            )
          : C.StakeCredential.from_scripthash(
              C.ScriptHash.from_bytes(
                fromHex(addressDetails.stakeCredential.hash)
              )
            );

      that.txBuilder.add_certificate(
        C.Certificate.new_stake_registration(
          C.StakeRegistration.new(credential)
        ),
        undefined
      );
    });
    return this;
  }

  /** Deregister a reward address. */
  deregisterStake(rewardAddress: RewardAddress, redeemer?: Redeemer): Tx {
    this.tasks.push((that) => {
      const addressDetails = that.lucid.utils.getAddressDetails(rewardAddress);

      if (addressDetails.type !== "Reward" || !addressDetails.stakeCredential) {
        throw new Error("Not a reward address provided.");
      }
      const credential =
        addressDetails.stakeCredential.type === "Key"
          ? C.StakeCredential.from_keyhash(
              C.Ed25519KeyHash.from_bytes(
                fromHex(addressDetails.stakeCredential.hash)
              )
            )
          : C.StakeCredential.from_scripthash(
              C.ScriptHash.from_bytes(
                fromHex(addressDetails.stakeCredential.hash)
              )
            );

      that.txBuilder.add_certificate(
        C.Certificate.new_stake_deregistration(
          C.StakeDeregistration.new(credential)
        ),
        redeemer
          ? C.ScriptWitness.new_plutus_witness(
              C.PlutusWitness.new(
                C.PlutusData.from_bytes(fromHex(redeemer!)),
                undefined,
                undefined
              )
            )
          : undefined
      );
    });
    return this;
  }

  /** Register a stake pool. A pool deposit is required. The metadataUrl needs to be hosted already before making the registration. */
  registerPool(poolParams: PoolParams): Tx {
    this.tasks.push(async (that) => {
      const poolRegistration = await createPoolRegistration(
        poolParams,
        that.lucid
      );

      const certificate = C.Certificate.new_pool_registration(poolRegistration);

      that.txBuilder.add_certificate(certificate, undefined);
    });
    return this;
  }

  /** Update a stake pool. No pool deposit is required. The metadataUrl needs to be hosted already before making the update. */
  updatePool(poolParams: PoolParams): Tx {
    this.tasks.push(async (that) => {
      const poolRegistration = await createPoolRegistration(
        poolParams,
        that.lucid
      );

      // This flag makes sure a pool deposit is not required
      poolRegistration.set_is_update(true);

      const certificate = C.Certificate.new_pool_registration(poolRegistration);

      that.txBuilder.add_certificate(certificate, undefined);
    });
    return this;
  }
  /**
   * Retire a stake pool. The epoch needs to be the greater than the current epoch + 1 and less than current epoch + eMax.
   * The pool deposit will be sent to reward address as reward after full retirement of the pool.
   */
  retirePool(poolId: PoolId, epoch: number): Tx {
    this.tasks.push((that) => {
      const certificate = C.Certificate.new_pool_retirement(
        C.PoolRetirement.new(C.Ed25519KeyHash.from_bech32(poolId), epoch)
      );
      that.txBuilder.add_certificate(certificate, undefined);
    });
    return this;
  }

  withdraw(
    rewardAddress: RewardAddress,
    amount: Lovelace,
    redeemer?: Redeemer
  ): Tx {
    this.tasks.push((that) => {
      that.txBuilder.add_withdrawal(
        C.RewardAddress.from_address(
          addressFromWithNetworkCheck(rewardAddress, that.lucid)
        )!,
        C.BigNum.from_str(amount.toString()),
        redeemer
          ? C.ScriptWitness.new_plutus_witness(
              C.PlutusWitness.new(
                C.PlutusData.from_bytes(fromHex(redeemer!)),
                undefined,
                undefined
              )
            )
          : undefined
      );
    });
    return this;
  }

  /**
   * Needs to be a public key address.
   * The PaymentKeyHash is taken when providing a Base, Enterprise or Pointer address.
   * The StakeKeyHash is taken when providing a Reward address.
   */
  addSigner(address: Address | RewardAddress): Tx {
    const addressDetails = this.lucid.utils.getAddressDetails(address);

    if (!addressDetails.paymentCredential && !addressDetails.stakeCredential) {
      throw new Error("Not a valid address.");
    }

    const credential =
      addressDetails.type === "Reward"
        ? addressDetails.stakeCredential!
        : addressDetails.paymentCredential!;

    if (credential.type === "Script") {
      throw new Error("Only key hashes are allowed as signers.");
    }
    return this.addSignerKey(credential.hash);
  }

  /** Add a payment or stake key hash as a required signer of the transaction. */
  addSignerKey(keyHash: PaymentKeyHash | StakeKeyHash): Tx {
    this.tasks.push((that) => {
      that.txBuilder.add_required_signer(
        C.Ed25519KeyHash.from_bytes(fromHex(keyHash))
      );
    });
    return this;
  }

  validFrom(unixTime: UnixTime): Tx {
    this.tasks.push((that) => {
      const slot = that.lucid.utils.unixTimeToSlot(unixTime);
      that.txBuilder.set_validity_start_interval(
        C.BigNum.from_str(slot.toString())
      );
    });
    return this;
  }

  validTo(unixTime: UnixTime): Tx {
    this.tasks.push((that) => {
      const slot = that.lucid.utils.unixTimeToSlot(unixTime);
      that.txBuilder.set_ttl(C.BigNum.from_str(slot.toString()));
    });
    return this;
  }

  attachMetadata(label: Label, metadata: Json): Tx {
    this.tasks.push((that) => {
      that.txBuilder.add_json_metadatum(
        C.BigNum.from_str(label.toString()),
        JSON.stringify(metadata)
      );
    });
    return this;
  }

  /** Converts strings to bytes if prefixed with **'0x'**. */
  attachMetadataWithConversion(label: Label, metadata: Json): Tx {
    this.tasks.push((that) => {
      that.txBuilder.add_json_metadatum_with_schema(
        C.BigNum.from_str(label.toString()),
        JSON.stringify(metadata),
        C.MetadataJsonSchema.BasicConversions
      );
    });
    return this;
  }

  attachSpendingValidator(spendingValidator: SpendingValidator): Tx {
    this.tasks.push((that) => {
      attachScript(that, spendingValidator);
    });
    return this;
  }

  attachMintingPolicy(mintingPolicy: MintingPolicy): Tx {
    this.tasks.push((that) => {
      attachScript(that, mintingPolicy);
    });
    return this;
  }

  attachCertificateValidator(certValidator: CertificateValidator): Tx {
    this.tasks.push((that) => {
      attachScript(that, certValidator);
    });
    return this;
  }

  attachWithdrawalValidator(withdrawalValidator: WithdrawalValidator): Tx {
    this.tasks.push((that) => {
      attachScript(that, withdrawalValidator);
    });
    return this;
  }

  /** Conditionally apply to the transaction. */
  applyIf(condition: boolean, callback: (thisTx: Tx) => unknown): Tx {
    if (condition) this.tasks.push((that) => callback(that));
    return this;
  }

  /** Apply to the transaction. */
  apply(callback: (thisTx: Tx) => unknown): Tx {
    this.tasks.push((that) => callback(that));
    return this;
  }

  /** Compose transactions. */
  compose(tx: Tx | null): Tx {
    if (tx) this.tasks = this.tasks.concat(tx.tasks);
    return this;
  }

  async complete(options?: {
    change?: { address?: Address; outputData?: OutputData };
    coinSelection?: boolean;
    nativeUplc?: boolean;
  }): Promise<TxComplete> {
    const { enableChangeSplitting } = this.configuration;
    if (
      [
        options?.change?.outputData?.hash,
        options?.change?.outputData?.asHash,
        options?.change?.outputData?.inline,
      ].filter((b) => b).length > 1
    ) {
      throw new Error(
        "Not allowed to set hash, asHash and inline at the same time."
      );
    }

    let task = this.tasks.shift();
    while (task) {
      await task(this);
      task = this.tasks.shift();
    }

    const utxos = await this.lucid.wallet.getUtxosCore();
    const collateral = await this.lucid.wallet.getCollateralCore();

    const changeAddress: Core.Address = addressFromWithNetworkCheck(
      options?.change?.address || (await this.lucid.wallet.address()),
      this.lucid
    );

    if (options?.coinSelection || options?.coinSelection === undefined) {
      this.txBuilder.add_inputs_from(utxos, changeAddress);
    }

    if (enableChangeSplitting) {
      await this.splitChange();
    }

    this.txBuilder.balance(
      changeAddress,
      (() => {
        if (options?.change?.outputData?.hash) {
          return C.Datum.new_data_hash(
            C.DataHash.from_hex(options.change.outputData.hash)
          );
        } else if (options?.change?.outputData?.asHash) {
          this.txBuilder.add_plutus_data(
            C.PlutusData.from_bytes(fromHex(options.change.outputData.asHash))
          );
          return C.Datum.new_data_hash(
            C.hash_plutus_data(
              C.PlutusData.from_bytes(fromHex(options.change.outputData.asHash))
            )
          );
        } else if (options?.change?.outputData?.inline) {
          return C.Datum.new_data(
            C.Data.new(
              C.PlutusData.from_bytes(fromHex(options.change.outputData.inline))
            )
          );
        } else {
          return undefined;
        }
      })()
    );

    return new TxComplete(
      this.lucid,
      await this.txBuilder.construct(
        collateral || utxos,
        changeAddress,
        options?.nativeUplc === undefined ? true : options?.nativeUplc
      )
    );
  }

  /** Return the current transaction body in Hex encoded Cbor. */
  async toString(): Promise<string> {
    let task = this.tasks.shift();
    while (task) {
      await task(this);
      task = this.tasks.shift();
    }

    return toHex(this.txBuilder.to_bytes());
  }

  /**
   * Splits remaining assets into multiple change outputs
   * if there's enough ADA to cover for minimum UTxO requirements.
   *
   * The objective is to create one collateral output as well as
   * as many pure outputs as possible, since they cost the least to be consumed.
   *
   * It does so by following these steps:
   * 1. Sort the native assets cannonically
   * 2. Add outputs with a maximum of N native assets until these are exhausted
   * 3. Continously create pure ADA outputs with half of the remaining amount
   *    until said remaining amount is below the minimum K
   *
   * This is the advanced UTxO management algorithm used by Eternl
   */
  private async splitChange() {
    const { coinsPerUtxoByte } = await this.lucid.protocolParameters;
    const { changeNativeAssetChunkSize, changeMinUtxo } = this.configuration;

    const change = this.txBuilder
      .get_explicit_input()
      .checked_sub(this.txBuilder.get_explicit_output());

    let changeAda = change.coin();

    let changeAssets = valueToAssets(change);
    const changeAssetsArray = Object.keys(changeAssets)
      .filter((v) => v !== "lovelace")
      // Sort canonically so we group policy IDs together
      .sort((a, b) => a.localeCompare(b));

    changeAssets = changeAssetsArray.reduce(
      (res, key) => Object.assign(res, { [key]: changeAssets[key] }),
      {}
    );

    const numOutputsWithNativeAssets = Math.ceil(
      changeAssetsArray.length / changeNativeAssetChunkSize
    );

    let longestAddress = C.Address.from_bech32(
      await this.lucid.wallet.address()
    );

    const outputs = this.txBuilder.outputs();
    for (let i = 0; i < outputs.len(); i++) {
      const output = outputs.get(i);
      if (
        !longestAddress ||
        output.address().to_bech32(undefined).length >
          longestAddress.to_bech32(undefined).length
      ) {
        longestAddress = output.address();
      }
    }

    const minAdaPerOutput = C.min_ada_required(
      C.TransactionOutput.new(longestAddress, assetsToValue(changeAssets)),
      C.BigNum.from_str(coinsPerUtxoByte.toString())
    );

    // Do we have enough ADA in the change to split and still
    // statisfy minADA requirements?
    const shouldSplitChange =
      minAdaPerOutput
        .checked_mul(C.BigNum.from_str(numOutputsWithNativeAssets.toString()))
        .compare(changeAda) < 0;

    if (change.multiasset() && shouldSplitChange) {
      const assetChunks = chunk(changeAssetsArray, 20);

      for (const piece of assetChunks) {
        const val = assetsToValue(
          piece.reduce(
            (res, key) => Object.assign(res, { [key]: changeAssets[key] }),
            {}
          )
        );
        const minAda = C.min_ada_required(
          C.TransactionOutput.new(
            C.Address.from_bech32(await this.lucid.wallet.address()),
            val
          ),
          C.BigNum.from_str(coinsPerUtxoByte.toString())
        );

        const coin = minAda;

        val.set_coin(coin);
        changeAda = changeAda.checked_sub(coin);

        this.txBuilder.add_output(
          C.TransactionOutput.new(
            C.Address.from_bech32(await this.lucid.wallet.address()),
            val
          )
        );
      }
    }

    while (
      // If the half is more than the minimum, we can split it
      changeAda
        .checked_div(C.BigNum.from_str("2"))
        .compare(C.BigNum.from_str(changeMinUtxo)) >= 0
    ) {
      const half = changeAda.checked_div(C.BigNum.from_str("2"));
      changeAda = changeAda.checked_sub(half);
      this.txBuilder.add_output(
        C.TransactionOutput.new(
          C.Address.from_bech32(await this.lucid.wallet.address()),
          C.Value.new(half)
        )
      );
    }
  }
}

function attachScript(
  tx: Tx,
  {
    type,
    script,
  }:
    | SpendingValidator
    | MintingPolicy
    | CertificateValidator
    | WithdrawalValidator
) {
  if (type === "Native") {
    return tx.txBuilder.add_native_script(
      C.NativeScript.from_bytes(fromHex(script))
    );
  } else if (type === "PlutusV1") {
    return tx.txBuilder.add_plutus_script(
      C.PlutusScript.from_bytes(fromHex(applyDoubleCborEncoding(script)))
    );
  } else if (type === "PlutusV2") {
    return tx.txBuilder.add_plutus_v2_script(
      C.PlutusScript.from_bytes(fromHex(applyDoubleCborEncoding(script)))
    );
  }
  throw new Error("No variant matched.");
}

async function createPoolRegistration(
  poolParams: PoolParams,
  lucid: Lucid
): Promise<Core.PoolRegistration> {
  const poolOwners = C.Ed25519KeyHashes.new();
  poolParams.owners.forEach((owner) => {
    const { stakeCredential } = lucid.utils.getAddressDetails(owner);
    if (stakeCredential?.type === "Key") {
      poolOwners.add(C.Ed25519KeyHash.from_hex(stakeCredential.hash));
    } else throw new Error("Only key hashes allowed for pool owners.");
  });

  const metadata = poolParams.metadataUrl
    ? await fetch(poolParams.metadataUrl).then((res) => res.arrayBuffer())
    : null;

  const metadataHash = metadata
    ? C.PoolMetadataHash.from_bytes(C.hash_blake2b256(new Uint8Array(metadata)))
    : null;

  const relays = C.Relays.new();
  poolParams.relays.forEach((relay) => {
    switch (relay.type) {
      case "SingleHostIp": {
        const ipV4 = relay.ipV4
          ? C.Ipv4.new(
              new Uint8Array(relay.ipV4.split(".").map((b) => parseInt(b)))
            )
          : undefined;
        const ipV6 = relay.ipV6
          ? C.Ipv6.new(fromHex(relay.ipV6.replaceAll(":", "")))
          : undefined;
        relays.add(
          C.Relay.new_single_host_addr(
            C.SingleHostAddr.new(relay.port, ipV4, ipV6)
          )
        );
        break;
      }
      case "SingleHostDomainName": {
        relays.add(
          C.Relay.new_single_host_name(
            C.SingleHostName.new(
              relay.port,
              C.DNSRecordAorAAAA.new(relay.domainName!)
            )
          )
        );
        break;
      }
      case "MultiHost": {
        relays.add(
          C.Relay.new_multi_host_name(
            C.MultiHostName.new(C.DNSRecordSRV.new(relay.domainName!))
          )
        );
        break;
      }
    }
  });

  return C.PoolRegistration.new(
    C.PoolParams.new(
      C.Ed25519KeyHash.from_bech32(poolParams.poolId),
      C.VRFKeyHash.from_hex(poolParams.vrfKeyHash),
      C.BigNum.from_str(poolParams.pledge.toString()),
      C.BigNum.from_str(poolParams.cost.toString()),
      C.UnitInterval.from_float(poolParams.margin),
      C.RewardAddress.from_address(
        addressFromWithNetworkCheck(poolParams.rewardAddress, lucid)
      )!,
      poolOwners,
      relays,
      metadataHash
        ? C.PoolMetadata.new(C.URL.new(poolParams.metadataUrl!), metadataHash)
        : undefined
    )
  );
}

function addressFromWithNetworkCheck(
  address: Address | RewardAddress,
  lucid: Lucid
): Core.Address {
  const addressDetails = lucid.utils.getAddressDetails(address);

  const actualNetworkId = networkToId(lucid.network);
  if (addressDetails.networkId !== actualNetworkId) {
    throw new Error(
      `Invalid address: Expected address with network id ${actualNetworkId}, but got ${addressDetails.networkId}`
    );
  }
  return C.Address.from_bech32(address);
}
