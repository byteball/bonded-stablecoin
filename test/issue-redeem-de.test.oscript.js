const path = require('path')
// eslint-disable-next-line no-unused-vars
const { Testkit, Utils } = require('aa-testkit')
const formulaCommon = require('ocore/formula/common.js');
const { expect } = require('chai');
const { Network } = Testkit({
	TESTDATA_DIR: path.join(__dirname, '../testdata'),
})

const network_fee = 4000
const de_fee = 3000
const de2fund_bytes = 2000

function round(n, precision) {
	return Math.round(n * 10 ** precision) / 10 ** precision;
}

describe('issue redeem', function () {
	this.timeout(120 * 1000)

	before(async () => {
		this.network = await Network.create()
			.with.numberOfWitnesses(1)
			.with.agent({ bank: path.join(__dirname, '../node_modules/bank-aa/bank.oscript') })
			.with.agent({ bs: path.join(__dirname, '../decision-engine/bonded-stablecoin.oscript') })
			.with.agent({ bsf: path.join(__dirname, '../decision-engine/bonded-stablecoin-factory.oscript') })
			.with.agent({ fund: path.join(__dirname, '../decision-engine/stability-fund.oscript') })
			.with.agent({ de: path.join(__dirname, '../decision-engine/decision-engine.oscript') })
			.with.agent({ governance: path.join(__dirname, '../decision-engine/governance.oscript') })
			.with.agent({ deposits: path.join(__dirname, '../deposits.oscript') })
			.with.wallet({ oracle: 1e9 })
			.with.wallet({ alice: 10000e9 })
			.with.wallet({ bob: 1000e9 })
		//	.with.wallet({ charlie: 1000e9 })
		//	.with.explorer()
			.run()
		console.log('--- agents\n', this.network.agent)
	//	console.log('--- wallets\n', this.network.wallet)
		this.oracle = this.network.wallet.oracle
		this.oracleAddress = await this.oracle.getAddress()
		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()
		this.bob = this.network.wallet.bob
		this.bobAddress = await this.bob.getAddress()

		const balance = await this.bob.getBalance()
		console.log(balance)
		expect(balance.base.stable).to.be.equal(1000e9)
	})

	it('Bob defines a new stablecoin', async () => {
		const { error: tf_error } = await this.network.timefreeze()
		expect(tf_error).to.be.null

		const ts = Math.floor(Date.now() / 1000)
		this.fee_multiplier = 5
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.network.agent.bsf,
			amount: 15000,
			data: {
				reserve_asset: 'base',
				reserve_asset_decimals: 9,
				decimals1: 9,
				decimals2: 2,
				m: 2,
				n: 2,
				fee_multiplier: this.fee_multiplier,
				interest_rate: 0,
				allow_grants: true,
				oracle1: this.oracleAddress,
				feed_name1: 'GBYTE_USD',
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.bob.readAAStateVars(this.network.agent.bsf)
		console.log('vars', vars)
		expect(Object.keys(vars).length).to.be.equal(8)
		for (let name in vars) {
			if (name.startsWith('curve_')) {
				this.curve_aa = name.substr(6)
				expect(vars[name]).to.be.equal("s1^2 s2^2")
			}
		}
		this.asset1 = vars['asset_' + this.curve_aa + '_1'];
		this.asset2 = vars['asset_' + this.curve_aa + '_2'];
		this.asset_stable = vars['asset_' + this.curve_aa + '_stable'];
		this.shares_asset = vars['asset_' + this.curve_aa + '_fund'];
		this.deposit_aa = vars['deposit_aa_' + this.curve_aa];
		this.governance_aa = vars['governance_aa_' + this.curve_aa];
		this.fund_aa = vars['fund_aa_' + this.curve_aa];

		const { vars: curve_vars } = await this.bob.readAAStateVars(this.curve_aa)
		console.log('curve vars', curve_vars, this.curve_aa)
		expect(curve_vars['asset1']).to.be.equal(this.asset1)
		expect(curve_vars['asset2']).to.be.equal(this.asset2)
		expect(curve_vars['governance_aa']).to.be.equal(this.governance_aa)
		expect(curve_vars['fund_aa']).to.be.equal(this.fund_aa)
		expect(curve_vars['growth_factor']).to.be.equal(1)
		expect(curve_vars['dilution_factor']).to.be.equal(1)
		expect(curve_vars['interest_rate']).to.be.equal(0)
		expect(parseInt(curve_vars['rate_update_ts'])).to.be.gte(ts)

		this.decision_engine_aa = curve_vars['decision_engine_aa'];

		this.getReserve = (s1, s2) => Math.ceil(1e9*(s1/1e9)**2 * (s2/1e2)**2)
		this.getP1 = (s1, s2) => 2 * (s1/1e9) * (s2/1e2)**2
		this.getP2 = (s1, s2) => (s1/1e9)**2 * 2 * (s2/1e2)
		this.getDistance = (p2, target_p2) => Math.abs(p2 - target_p2) / Math.min(p2, target_p2)
		this.getFee = (avg_reserve, old_distance, new_distance) => Math.ceil(avg_reserve * (new_distance**2 - old_distance**2) * this.fee_multiplier);

		this.buy = (tokens1, tokens2) => {
			const new_supply1 = this.supply1 + tokens1
			const new_supply2 = this.supply2 + tokens2
			const new_reserve = this.getReserve(new_supply1, new_supply2)
			const amount = new_reserve - this.reserve
			const abs_reserve_delta = Math.abs(amount)
			const avg_reserve = (this.reserve + new_reserve)/2
			const p2 = this.getP2(new_supply1, new_supply2)
	
			const old_distance = this.reserve ? this.getDistance(this.p2, this.target_p2) : 0
			const new_distance = this.getDistance(p2, this.target_p2)
			let fee = this.getFee(avg_reserve, old_distance, new_distance);
			if (fee > 0) {
				const reverse_reward = Math.floor((1 - old_distance / new_distance) * this.fast_capacity); // rough approximation
			}

			const fee_percent = round(fee / abs_reserve_delta * 100, 4)
			const reward = old_distance ? Math.floor((1 - new_distance / old_distance) * this.fast_capacity) : 0;
			const reward_percent = round(reward / abs_reserve_delta * 100, 4)

			console.log('p2 =', p2, 'target p2 =', this.target_p2, 'amount =', amount, 'fee =', fee, 'reward =', reward, 'old distance =', old_distance, 'new distance =', new_distance, 'fast capacity =', this.fast_capacity)
	
			this.p2 = p2
			this.distance = new_distance
			if (fee > 0) {
				this.slow_capacity += Math.floor(fee / 2)
				this.fast_capacity += fee - Math.floor(fee / 2)
			}
			else if (reward > 0)
				this.fast_capacity -= reward
			
			if (fee > 0 && reward > 0)
				throw Error("both fee and reward are positive");
			if (fee < 0 && reward < 0)
				throw Error("both fee and reward are negative");
	
			this.supply1 += tokens1
			this.supply2 += tokens2
			this.reserve += amount
	
			return { amount, fee, fee_percent, reward, reward_percent }
		}

		this.supply1 = 0
		this.supply2 = 0
		this.reserve = 0
		this.slow_capacity = 0
		this.fast_capacity = 0
		this.distance = 0

	})

	it('Post data feed', async () => {
		const price = 20
		const { unit, error } = await this.oracle.sendMulti({
			messages: [{
				app: 'data_feed',
				payload: {
					GBYTE_USD: price,
				}
			}],
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.oracle.getUnitInfo({ unit: unit })
		const dfMessage = unitObj.messages.find(m => m.app === 'data_feed')
		expect(dfMessage.payload.GBYTE_USD).to.be.equal(price)
		await this.network.witnessUntilStable(unit)

		this.target_p2 = 1/price
	})

	it('Alice tries to buy tokens directly and fails', async () => {
		const tokens1 = 1e9
		const tokens2 = 1e2

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.curve_aa,
			amount: 100e9,
			data: {
				tokens1: tokens1,
				tokens2: tokens2,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)

		expect(response.response.error).to.be.eq("only stability fund is allowed to transact in T1")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.validUnit
	})

	it('Alice buys shares, the DE buys tokens', async () => {
		const amount = 3.5e9
		const r = amount / 1e9
		const s2 = 2 * r / this.target_p2
		const s1 = (r / s2 ** 2) ** 0.5
		console.log({r, s1, s2})
		
		const tokens2 = Math.floor(s2 * 1e2)
		const tokens1 = Math.floor(s1 * 1e9)
		const { amount: consumed_amount, fee, fee_percent } = this.buy(tokens1, tokens2)
		console.log({ amount, consumed_amount })
		expect(consumed_amount).to.be.lte(amount)

		const { unit, error } = await this.alice.sendBytes({
			toAddress: this.decision_engine_aa,
			amount: amount + 1e4 + network_fee,
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.alice.readAAStateVars(this.curve_aa)
		console.log(vars)
		expect(vars['supply1']).to.be.equal(this.supply1)
		expect(vars['supply2']).to.be.equal(this.supply2)
		expect(vars['reserve']).to.be.equal(this.reserve)
		expect(round(vars['p2'], 13)).to.be.equal(round(this.p2, 13))
		expect(vars['slow_capacity']).to.be.eq(this.slow_capacity)
		expect(vars['fast_capacity']).to.be.eq(this.fast_capacity)
		expect(vars['lost_peg_ts']).to.be.undefined

		const { vars: de_vars } = await this.alice.readAAStateVars(this.decision_engine_aa)
		expect(de_vars['below_peg_ts']).to.be.undefined

		const { vars: fund_vars } = await this.alice.readAAStateVars(this.fund_aa)
		expect(fund_vars['shares_supply']).to.be.eq(amount + network_fee)
		this.shares_supply = fund_vars['shares_supply']

		// DE to fund
		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.fund_aa,
				amount: amount + 5000 + network_fee,
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data.forwarded_data).to.be.deep.eq({ tokens1, tokens2 })
		
		// fund to curve and alice
		const { response: response2 } = await this.network.getAaResponseToUnit(response.response_unit)
		const { unitObj: unitObj2 } = await this.alice.getUnitInfo({ unit: response2.response_unit })
		expect(Utils.getExternalPayments(unitObj2)).to.deep.equalInAnyOrder([
			{
				address: this.curve_aa,
				amount: amount + network_fee,
			},
			{
				asset: this.shares_asset,
				address: this.aliceAddress,
				amount: amount + network_fee,
			},
		])
		const data2 = unitObj2.messages.find(m => m.app === 'data').payload
		expect(data2).to.be.deep.eq({ tokens1, tokens2 })

		// curve to fund
		const { response: response3 } = await this.network.getAaResponseToUnit(response2.response_unit)
		console.log('resp3 vars', response3.response.responseVars)
		expect(response3.response.responseVars.fee).to.be.eq(fee)
		const { unitObj: unitObj3 } = await this.alice.getUnitInfo({ unit: response3.response_unit })
		expect(Utils.getExternalPayments(unitObj3)).to.deep.equalInAnyOrder([
			{
				address: this.fund_aa,
				asset: this.asset1,
				amount: tokens1,
			},
			{
				address: this.fund_aa,
				asset: this.asset2,
				amount: tokens2,
			},
			{ // the curve returns the excess reserve asset
				address: this.fund_aa,
				amount: amount - consumed_amount - fee,
			},
		])
		expect(unitObj3.messages.find(m => m.app === 'data')).to.be.undefined

	})


	it('Alice buys more of tokens2, the DE immediately corrects the price', async () => {
		const initial_p2 = round(this.p2, 16)
		const tokens1 = 0
		const tokens2 = 10e2
		const { amount, fee, fee_percent } = this.buy(tokens1, tokens2)
		console.log({ amount, fee, fee_percent })
		const p2_1 = this.p2
		const distance_1 = this.distance

		const target_s1 = (this.target_p2 / 2 * (this.supply2 / 1e2) ** (1 - 2)) ** (1 / 2)
		const tokens1_delta = Math.round(target_s1 * 1e9) - this.supply1
		expect(tokens1_delta).to.be.lt(0)
		const { amount: amount2, reward } = this.buy(tokens1_delta, 0)
		console.log({ amount2, reward })

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.curve_aa,
			amount: amount + fee + network_fee,
			data: {
				tokens2: tokens2,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['fee%']).to.be.equal(fee_percent+'%')
		expect(response.response.responseVars.fee).to.be.eq(fee)

		const { vars } = await this.alice.readAAStateVars(this.curve_aa)
		console.log(vars)
		expect(vars['supply1']).to.be.equal(this.supply1)
		expect(vars['supply2']).to.be.equal(this.supply2)
		expect(vars['reserve']).to.be.equal(this.reserve)
		expect(vars['slow_capacity']).to.be.equal(this.slow_capacity)
		expect(vars['fast_capacity']).to.be.equal(this.fast_capacity)
		expect(vars['lost_peg_ts']).to.be.undefined

		const { vars: de_vars } = await this.alice.readAAStateVars(this.decision_engine_aa)
		expect(de_vars['below_peg_ts']).to.be.undefined

		// curve to DE and alice
		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				asset: this.asset2,
				amount: tokens2,
			},
			{
				address: this.decision_engine_aa,
				amount: de_fee,
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		data.tx.res.fee_percent = round(data.tx.res.fee_percent, 4)
		expect(data).to.be.deep.eq({
			tx: {
				tokens2,
				res: {
					reserve_needed: amount + fee,
					reserve_delta: amount,
					fee,
					regular_fee: fee,
					reward: 0,
					initial_p2,
					p2: p2_1,
					target_p2: this.target_p2,
					new_distance: round(distance_1, 15),
					turnover: amount,
					fee_percent,
					slow_capacity_share: 0.5,
				}
			}
		})
		
		// DE to fund
		const { response: response2 } = await this.network.getAaResponseToUnit(response.response_unit)
		expect(response2.response.responseVars.message).to.be.equal("DE fixed the peg")
		const { unitObj: unitObj2 } = await this.alice.getUnitInfo({ unit: response2.response_unit })
		expect(Utils.getExternalPayments(unitObj2)).to.deep.equalInAnyOrder([
			{
				address: this.fund_aa,
				amount: de2fund_bytes,
			},
		])
		const data2 = unitObj2.messages.find(m => m.app === 'data').payload
		expect(data2).to.be.deep.equalInAnyOrder({
			payments: [{
				asset: this.asset1, address: this.curve_aa, amount: -tokens1_delta
			}]
		})

		// fund to curve
		const { response: response3 } = await this.network.getAaResponseToUnit(response2.response_unit)
		const { unitObj: unitObj3 } = await this.alice.getUnitInfo({ unit: response3.response_unit })
		expect(Utils.getExternalPayments(unitObj3)).to.deep.equalInAnyOrder([
			{
				address: this.curve_aa,
				asset: this.asset1,
				amount: -tokens1_delta,
			},
		])
		expect(unitObj3.messages.find(m => m.app === 'data')).to.be.undefined

		// curve to fund
		const { response: response4 } = await this.network.getAaResponseToUnit(response3.response_unit)
		console.log('resp4 vars', response4.response.responseVars)
		expect(response4.response.responseVars.reward).to.be.eq(reward)
		const { unitObj: unitObj4 } = await this.alice.getUnitInfo({ unit: response4.response_unit })
		expect(Utils.getExternalPayments(unitObj4)).to.deep.equalInAnyOrder([
			{
				address: this.fund_aa,
				amount: -amount2 + reward - network_fee,
			},
		])
		expect(unitObj4.messages.find(m => m.app === 'data')).to.be.undefined

		// the fund didn't respond
		const { response: response5 } = await this.network.getAaResponseToUnit(response4.response_unit)
		expect(response5.response_unit).to.be.null
	})


	it("Alice redeems part of tokens2, the price gets under the peg and the DE does not interfere", async () => {
		const tokens1 = 0
		const tokens2 = 5e2
		const { amount, fee, fee_percent, reward, reward_percent } = this.buy(-tokens1, -tokens2)

		const { unit, error } = await this.alice.sendMulti({
			asset: this.asset2,
			base_outputs: [{ address: this.curve_aa, amount: 1e4 }],
			asset_outputs: [{ address: this.curve_aa, amount: tokens2 }],
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.fee).to.be.equal(fee)

		const { vars } = await this.alice.readAAStateVars(this.curve_aa)
		console.log(vars)
		expect(vars['supply1']).to.be.equal(this.supply1)
		expect(vars['supply2']).to.be.equal(this.supply2)
		expect(vars['reserve']).to.be.equal(this.reserve)
		expect(vars['slow_capacity']).to.be.equal(this.slow_capacity)
		expect(vars['fast_capacity']).to.be.equal(this.fast_capacity)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(vars['lost_peg_ts']).to.be.equal(unitObj.timestamp)
		this.lost_peg_ts = vars['lost_peg_ts']

		const { vars: de_vars } = await this.alice.readAAStateVars(this.decision_engine_aa)
		expect(de_vars['below_peg_ts']).to.be.eq(unitObj.timestamp)
		this.below_peg_ts = de_vars['below_peg_ts']

		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				amount: -amount - fee + 10000 - network_fee,
			},
			{
				address: this.decision_engine_aa,
				amount: de_fee,
			},
		])

		const { response: response2 } = await this.network.getAaResponseToUnit(response.response_unit)
		expect(response2.response_unit).to.be.null
		expect(response2.response.responseVars.message).to.be.equal("DE does not interfere yet")

	})

	it("Alice buys back part of tokens2, the price is still under the peg and the DE does not interfere", async () => {
		const { time_error } = await this.network.timetravel({shift: '1h'})
		expect(time_error).to.be.undefined

		const tokens1 = 0
		const tokens2 = 3e2
		const { amount, fee, fee_percent, reward, reward_percent } = this.buy(tokens1, tokens2)
		expect(fee).to.be.lte(0)
		expect(reward).to.be.gt(0)

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.curve_aa,
			amount: amount - reward + network_fee,
			data: {
				tokens2: tokens2,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.reward).to.be.equal(reward)

		const { vars } = await this.alice.readAAStateVars(this.curve_aa)
		console.log(vars)
		expect(vars['supply1']).to.be.equal(this.supply1)
		expect(vars['supply2']).to.be.equal(this.supply2)
		expect(vars['reserve']).to.be.equal(this.reserve)
		expect(vars['slow_capacity']).to.be.equal(this.slow_capacity)
		expect(vars['fast_capacity']).to.be.equal(this.fast_capacity)
		expect(vars['lost_peg_ts']).to.be.equal(this.lost_peg_ts)

		const { vars: de_vars } = await this.alice.readAAStateVars(this.decision_engine_aa)
		expect(de_vars['below_peg_ts']).to.be.eq(this.below_peg_ts)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				asset: this.asset2,
				amount: tokens2,
			},
			{
				address: this.decision_engine_aa,
				amount: de_fee,
			},
		])

		const { response: response2 } = await this.network.getAaResponseToUnit(response.response_unit)
		expect(response2.response_unit).to.be.null
		expect(response2.response.responseVars.message).to.be.equal("DE does not interfere yet")
	})

	it("Alice triggers the DE to act but it's too early", async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.decision_engine_aa,
			amount: 1e4,
			data: {
				act: 1,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.be.equal("DE does not interfere yet")

		const { vars: de_vars } = await this.alice.readAAStateVars(this.decision_engine_aa)
		expect(de_vars['below_peg_ts']).to.be.eq(this.below_peg_ts)

	})


	it("Alice waits and triggers the DE to act", async () => {
		const { time_error } = await this.network.timetravel({shift: '11h'})
		expect(time_error).to.be.undefined

		const target_s1 = (this.target_p2 / 2 * (this.supply2 / 1e2) ** (1 - 2)) ** (1 / 2)
		const tokens1_delta = Math.round(target_s1 * 1e9) - this.supply1
		expect(tokens1_delta).to.be.gt(0)
		const { amount, reward } = this.buy(tokens1_delta, 0)
		console.log({ amount, reward })

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.decision_engine_aa,
			amount: 1e4,
			data: {
				act: 1,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.be.equal("DE fixed the peg")

		const { vars: de_vars } = await this.alice.readAAStateVars(this.decision_engine_aa)
		expect(de_vars['below_peg_ts']).to.be.undefined

		const { vars } = await this.alice.readAAStateVars(this.curve_aa)
		console.log(vars)
		expect(vars['supply1']).to.be.equal(this.supply1)
		expect(vars['supply2']).to.be.equal(this.supply2)
		expect(vars['reserve']).to.be.equal(this.reserve)
		expect(vars['slow_capacity']).to.be.equal(this.slow_capacity)
		expect(vars['fast_capacity']).to.be.equal(this.fast_capacity)
		expect(vars['lost_peg_ts']).to.be.undefined

		// DE to fund
		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.fund_aa,
				amount: de2fund_bytes,
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.be.deep.equalInAnyOrder({
			payments: [{
				asset: 'base', address: this.curve_aa, amount: amount - reward + network_fee
			}],
			forwarded_data: {tokens1: tokens1_delta}
		})

		// fund to curve
		const { response: response2 } = await this.network.getAaResponseToUnit(response.response_unit)
		const { unitObj: unitObj2 } = await this.alice.getUnitInfo({ unit: response2.response_unit })
		expect(Utils.getExternalPayments(unitObj2)).to.deep.equalInAnyOrder([
			{
				address: this.curve_aa,
				amount: amount - reward + network_fee,
			},
		])
		expect(unitObj2.messages.find(m => m.app === 'data').payload).to.be.deep.eq({tokens1: tokens1_delta})

		// curve to fund
		const { response: response3 } = await this.network.getAaResponseToUnit(response2.response_unit)
		console.log('resp3 vars', response3.response.responseVars)
		expect(response3.response.responseVars.reward).to.be.eq(reward)
		const { unitObj: unitObj3 } = await this.alice.getUnitInfo({ unit: response3.response_unit })
		expect(Utils.getExternalPayments(unitObj3)).to.deep.equalInAnyOrder([
			{
				asset: this.asset1,
				address: this.fund_aa,
				amount: tokens1_delta,
			},
		])
		expect(unitObj3.messages.find(m => m.app === 'data')).to.be.undefined

		// the fund didn't respond
		const { response: response4 } = await this.network.getAaResponseToUnit(response3.response_unit)
		expect(response4.response_unit).to.be.null
	})


	it("Bob buys shares in the fund", async () => {
		const balances = await this.bob.getOutputsBalanceOf(this.fund_aa);
		expect(balances[this.asset1].total).to.be.eq(this.supply1)
		const bytes_balance = balances.base.total
		const p1 = this.getP1(this.supply1, this.supply2)
		const share_price_in_gb = (bytes_balance / 1e9 + p1 * this.supply1 / 1e9) / this.shares_supply
		const share_price_in_bytes = share_price_in_gb * 1e9

		const amount = 1e9
		const shares = Math.floor(amount / share_price_in_bytes)
		
		const { unit, error } = await this.bob.sendBytes({
			toAddress: this.decision_engine_aa,
			amount: amount + 1e4,
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		// DE to fund
		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.fund_aa,
				amount: amount + 5000,
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.be.deep.equalInAnyOrder({
			payments: [{
				asset: this.shares_asset, address: this.bobAddress, amount: shares
			}],
		})

		// fund to bob
		const { response: response2 } = await this.network.getAaResponseToUnit(response.response_unit)
		const { unitObj: unitObj2 } = await this.bob.getUnitInfo({ unit: response2.response_unit })
		expect(Utils.getExternalPayments(unitObj2)).to.deep.equalInAnyOrder([
			{
				asset: this.shares_asset,
				address: this.bobAddress,
				amount: shares,
			},
		])
		expect(unitObj2.messages.find(m => m.app === 'data')).to.be.undefined

		this.shares_supply += shares
		const { vars: fund_vars } = await this.bob.readAAStateVars(this.fund_aa)
		expect(fund_vars['shares_supply']).to.be.eq(this.shares_supply)

	})

	it('Post a new data feed with lower p2', async () => {
		const price = 22
		const { unit, error } = await this.oracle.sendMulti({
			messages: [{
				app: 'data_feed',
				payload: {
					GBYTE_USD: price,
				}
			}],
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.oracle.getUnitInfo({ unit: unit })
		const dfMessage = unitObj.messages.find(m => m.app === 'data_feed')
		expect(dfMessage.payload.GBYTE_USD).to.be.equal(price)
		await this.network.witnessUntilStable(unit)

		this.target_p2 = 1/price
	})


	it("Alice triggers the DE to act, it redeems T1", async () => {
		const target_s1 = (this.target_p2 / 2 * (this.supply2 / 1e2) ** (1 - 2)) ** (1 / 2)
		const tokens1_delta = Math.round(target_s1 * 1e9) - this.supply1
		expect(tokens1_delta).to.be.lt(0)
		const { amount, reward } = this.buy(tokens1_delta, 0)
		console.log({ amount, reward })

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.decision_engine_aa,
			amount: 1e4,
			data: {
				act: 1,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.be.equal("DE fixed the peg")

		const { vars: de_vars } = await this.alice.readAAStateVars(this.decision_engine_aa)
		expect(de_vars['below_peg_ts']).to.be.undefined

		const { vars } = await this.alice.readAAStateVars(this.curve_aa)
		console.log(vars)
		expect(vars['supply1']).to.be.equal(this.supply1)
		expect(vars['supply2']).to.be.equal(this.supply2)
		expect(vars['reserve']).to.be.equal(this.reserve)
		expect(vars['slow_capacity']).to.be.equal(this.slow_capacity)
		expect(vars['fast_capacity']).to.be.equal(this.fast_capacity)
		expect(vars['lost_peg_ts']).to.be.undefined

		// DE to fund
		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.fund_aa,
				amount: de2fund_bytes,
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.be.deep.equalInAnyOrder({
			payments: [{
				asset: this.asset1, address: this.curve_aa, amount: -tokens1_delta
			}],
		})

		// fund to curve
		const { response: response2 } = await this.network.getAaResponseToUnit(response.response_unit)
		const { unitObj: unitObj2 } = await this.alice.getUnitInfo({ unit: response2.response_unit })
		expect(Utils.getExternalPayments(unitObj2)).to.deep.equalInAnyOrder([
			{
				asset: this.asset1,
				address: this.curve_aa,
				amount: -tokens1_delta,
			},
		])
		expect(unitObj2.messages.find(m => m.app === 'data')).to.be.undefined

		// curve to fund
		const { response: response3 } = await this.network.getAaResponseToUnit(response2.response_unit)
		console.log('resp3 vars', response3.response.responseVars)
		expect(response3.response.responseVars.reward).to.be.eq(reward)
		const { unitObj: unitObj3 } = await this.alice.getUnitInfo({ unit: response3.response_unit })
		expect(Utils.getExternalPayments(unitObj3)).to.deep.equalInAnyOrder([
			{
				address: this.fund_aa,
				amount: -amount + reward - network_fee,
			},
		])
		expect(unitObj3.messages.find(m => m.app === 'data')).to.be.undefined

		// the fund didn't respond
		const { response: response4 } = await this.network.getAaResponseToUnit(response3.response_unit)
		expect(response4.response_unit).to.be.null
	})


	it('Post a new data feed with higher p2', async () => {
		const price = 20
		const { unit, error } = await this.oracle.sendMulti({
			messages: [{
				app: 'data_feed',
				payload: {
					GBYTE_USD: price,
				}
			}],
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.oracle.getUnitInfo({ unit: unit })
		const dfMessage = unitObj.messages.find(m => m.app === 'data_feed')
		expect(dfMessage.payload.GBYTE_USD).to.be.equal(price)
		await this.network.witnessUntilStable(unit)

		this.target_p2 = 1/price
	})


	it("Alice triggers the DE to act, it records below_peg_ts only", async () => {

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.decision_engine_aa,
			amount: 1e4,
			data: {
				act: 1,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.be.equal("DE does not interfere yet")

		const { unitObj } = await this.oracle.getUnitInfo({ unit: unit })

		const { vars: de_vars } = await this.alice.readAAStateVars(this.decision_engine_aa)
		expect(de_vars['below_peg_ts']).to.be.eq(unitObj.timestamp)
		this.below_peg_ts = de_vars['below_peg_ts']
	})
	

	it("Alice waits and triggers the DE to act again, nothing changes", async () => {
		const { time_error } = await this.network.timetravel({shift: '1h'})
		expect(time_error).to.be.undefined

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.decision_engine_aa,
			amount: 1e4,
			data: {
				act: 1,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.be.equal("DE does not interfere yet")

		const { vars: de_vars } = await this.alice.readAAStateVars(this.decision_engine_aa)
		expect(de_vars['below_peg_ts']).to.be.eq(this.below_peg_ts)
	})
	

	it('Post a new data feed with lower p2 almost returning to the curve price', async () => {
		const price = 21.99
		const { unit, error } = await this.oracle.sendMulti({
			messages: [{
				app: 'data_feed',
				payload: {
					GBYTE_USD: price.toString(),
				}
			}],
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.oracle.getUnitInfo({ unit: unit })
		const dfMessage = unitObj.messages.find(m => m.app === 'data_feed')
		expect(dfMessage.payload.GBYTE_USD).to.be.equal(price.toString())
		await this.network.witnessUntilStable(unit)

		this.target_p2 = 1/price
	})


	it("Alice triggers the DE to act, it resets below_peg_ts only as the price is only sligtly below the target", async () => {

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.decision_engine_aa,
			amount: 1e4,
			data: {
				act: 1,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.be.equal("DE does not interfere yet")

		const { vars: de_vars } = await this.alice.readAAStateVars(this.decision_engine_aa)
		expect(de_vars['below_peg_ts']).to.be.undefined

	})

	it("Alice redeems some shares in the fund", async () => {
		const balances = await this.alice.getOutputsBalanceOf(this.fund_aa);
		expect(balances[this.asset1].total).to.be.eq(this.supply1)
		const bytes_balance = balances.base.total

		const initial_p2 = round(this.p2, 16)

		const shares = 0.2e9
		const share = shares / this.shares_supply
		const bytes_amount = Math.floor(share * bytes_balance)
		const t1_amount = Math.floor(share * this.supply1)
		console.log({share, bytes_amount, t1_amount})
		
		// redeem for alice
		const { amount, fee, fee_percent } = this.buy(-t1_amount, 0)
		console.log({ amount, fee })

		const { unit, error } = await this.alice.sendMulti({
			asset: this.shares_asset,
			base_outputs: [{ address: this.decision_engine_aa, amount: 1e4 }],
			asset_outputs: [{ address: this.decision_engine_aa, amount: shares }],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		// DE to fund
		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.shares_asset,
				address: this.fund_aa,
				amount: shares,
			},
			{
				address: this.fund_aa,
				amount: 9000,
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.be.deep.equalInAnyOrder({
			payments: [{
				asset: this.asset1, address: this.curve_aa, amount: t1_amount
			}],
			forwarded_data: {notifyDE: 1}
		})

		// fund to curve
		const { response: response2 } = await this.network.getAaResponseToUnit(response.response_unit)
		const { unitObj: unitObj2 } = await this.alice.getUnitInfo({ unit: response2.response_unit })
		expect(Utils.getExternalPayments(unitObj2)).to.deep.equalInAnyOrder([
			{
				asset: this.asset1,
				address: this.curve_aa,
				amount: t1_amount,
			},
		])
		const data2 = unitObj2.messages.find(m => m.app === 'data').payload
		expect(data2).to.be.deep.eq({notifyDE: 1})

		// curve to fund and DE
		const { response: response3 } = await this.network.getAaResponseToUnit(response2.response_unit)
		const { unitObj: unitObj3 } = await this.alice.getUnitInfo({ unit: response3.response_unit })
		expect(Utils.getExternalPayments(unitObj3)).to.deep.equalInAnyOrder([
			{
				address: this.fund_aa,
				amount: -amount - fee - network_fee,
			},
			{
				address: this.decision_engine_aa,
				amount: de_fee,
			},
		])
		const data3 = unitObj3.messages.find(m => m.app === 'data').payload
		data3.tx.res.fee_percent = round(data3.tx.res.fee_percent, 4)
		data3.tx.res.new_distance = round(data3.tx.res.new_distance, 13)
		expect(data3).to.be.deep.eq({
			tx: {
				tokens2: 0,
				res: {
					reserve_needed: amount + fee,
					reserve_delta: amount,
					fee,
					regular_fee: fee,
					reward: 0,
					initial_p2,
					p2: round(this.p2, 16),
					target_p2: round(this.target_p2, 16),
					new_distance: round(this.distance, 13),
					turnover: -amount,
					fee_percent,
					slow_capacity_share: 0.5,
				}
			}
		})

		// DE to fund
		const { response: response4 } = await this.network.getAaResponseToUnitByAA(response3.response_unit, this.decision_engine_aa)
	//	const { response: response4 } = await this.network.getAaResponseToUnit(response3.response_unit)
	//	console.log('resp4', JSON.stringify(response4, null, 2))
		expect(response4.response_unit).to.be.validUnit
		const { unitObj: unitObj4 } = await this.alice.getUnitInfo({ unit: response4.response_unit })
		expect(Utils.getExternalPayments(unitObj4)).to.deep.equalInAnyOrder([
			{
				address: this.fund_aa,
				amount: de2fund_bytes,
			},
		])
		const data4 = unitObj4.messages.find(m => m.app === 'data').payload
		expect(data4).to.be.deep.equalInAnyOrder({
			payments: [{
				asset: 'base', address: this.aliceAddress, amount: bytes_amount + (-amount) - fee - network_fee
			}],
		})

		// fund to alice
		const { response: response5 } = await this.network.getAaResponseToUnit(response4.response_unit)
		const { unitObj: unitObj5 } = await this.alice.getUnitInfo({ unit: response5.response_unit })
		expect(Utils.getExternalPayments(unitObj5)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				amount: bytes_amount + (-amount) - fee - network_fee,
			},
		])
		expect(unitObj5.messages.find(m => m.app === 'data')).to.be.undefined


		this.shares_supply -= shares
		const { vars: fund_vars } = await this.alice.readAAStateVars(this.fund_aa)
		expect(fund_vars['shares_supply']).to.be.eq(this.shares_supply)

		const { vars: de_vars } = await this.alice.readAAStateVars(this.decision_engine_aa)
		expect(de_vars['redemption']).to.be.undefined

	})




	after(async () => {
		// uncomment this line to pause test execution to get time for Obyte DAG explorer inspection
	//	await Utils.sleep(3600 * 1000)
		await this.network.stop()
	})
})
