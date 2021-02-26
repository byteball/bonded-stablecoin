const path = require('path')
// eslint-disable-next-line no-unused-vars
const { Testkit, Utils } = require('aa-testkit')
const formulaCommon = require('ocore/formula/common.js');
const { Network } = Testkit({
	TESTDATA_DIR: path.join(__dirname, '../testdata'),
})

const network_fee = 4000
const aa2aa_fee = 2000
const de_fee = 3000

function round(n, precision) {
	return Math.round(n * 10 ** precision) / 10 ** precision;
}

describe('Governance change decision engine', function () {
	this.timeout(120 * 1000)

	before(async () => {
		this.network = await Network.create()
			.with.numberOfWitnesses(1)
			.with.agent({ bank: path.join(__dirname, '../node_modules/bank-aa/bank.oscript') })
			.with.agent({ bs: path.join(__dirname, '../decision-engine/bonded-stablecoin.oscript') })
			.with.agent({ bsf: path.join(__dirname, '../decision-engine/bonded-stablecoin-factory.oscript') })
			.with.agent({ fund: path.join(__dirname, '../decision-engine/stability-fund.oscript') })
			.with.agent({ de: path.join(__dirname, '../decision-engine/decision-engine.oscript') })
			.with.agent({ noopde: path.join(__dirname, '../decision-engine/noop-de.oscript') })
			.with.agent({ governance: path.join(__dirname, '../decision-engine/governance.oscript') })
			.with.agent({ deposits: path.join(__dirname, '../deposits.oscript') })
			.with.wallet({ oracle: 1e9 })
			.with.wallet({ alice: 10000e9 })
			.with.wallet({ bob: 1000e9 })
			.with.explorer()
			.run()
		console.log('--- agents\n', this.network.agent)
	//	console.log('--- wallets\n', this.network.wallet)
		this.oracle = this.network.wallet.oracle
		this.oracleAddress = await this.oracle.getAddress()
		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()
		this.bob = this.network.wallet.bob
		this.bobAddress = await this.bob.getAddress()
	//	this.explorer = await this.network.newObyteExplorer().ready()

		const balance = await this.bob.getBalance()
		console.log(balance)
		expect(balance.base.stable).to.be.equal(1000e9)
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
		expect(dfMessage.payload.GBYTE_USD).to.be.equal(20)
		await this.network.witnessUntilStable(unit)

		this.price = price
		this.target_p2 = 1/price
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


	it('Half a year later, Alice votes to change the DE', async () => {
		const { time_error } = await this.network.timetravel({shift: '180d'})
		expect(time_error).to.be.undefined

		const shares = Math.floor(this.shares_supply / 4)
		const name = 'decision_engine_aa'
		const value = this.network.agent.noopde

		const { unit, error } = await this.alice.sendMulti({
			asset: this.shares_asset,
			base_outputs: [{ address: this.governance_aa, amount: 1e4 }],
			asset_outputs: [{ address: this.governance_aa, amount: shares }],
			spend_unconfirmed: 'all',
			messages: [{
				app: 'data',
				payload: {
					name: name,
					value: value
				}
			}]
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.governance_aa)
		console.log(vars)
		expect(vars['support_' + name + '_' + value]).to.be.equal(shares)
		expect(vars['support_' + name + '_' + value + '_' + this.aliceAddress]).to.be.equal(shares)
		expect(vars['leader_' + name]).to.be.equal(value)
		expect(vars['balance_' + this.aliceAddress]).to.be.equal(shares)

		const { unitObj } = await this.alice.getUnitInfo({ unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(vars['challenging_period_start_ts_' + name]).to.be.equal(unitObj.timestamp)

		this.name = name
		this.value = value
		this.shares = shares
	})


	it('Bob waits for 5 days and tries to commit too early for an important governance decision but unsuccessful', async () => {
		const { time_error } = await this.network.timetravel({shift: '5d'})
		expect(time_error).to.be.undefined

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				name: this.name,
				commit: 1,
			}
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.equal('challenging period not expired yet')
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null

	})


	it('Bob waits for 25 days more and then commits successfully', async () => {
		const { time_error } = await this.network.timetravel({shift: '25d'})
		expect(time_error).to.be.undefined

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				name: this.name,
				commit: 1,
			}
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.bob.readAAStateVars(this.governance_aa)
		console.log(vars)
		expect(vars['support_' + this.name + '_' + this.value]).to.be.equal(this.shares)
		expect(vars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.equal(this.shares)
		expect(vars['leader_' + this.name]).to.be.equal(this.value)
		expect(vars[this.name]).to.be.equal(this.value)
		expect(vars['balance_' + this.aliceAddress]).to.be.equal(this.shares)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })

		const { vars: cvars } = await this.bob.readAAStateVars(this.curve_aa)
		console.log(cvars)
		expect(cvars[this.name]).to.be.equal(this.value)
		expect(cvars['decision_engine_aa']).to.be.equal(this.network.agent.noopde)

		this.decision_engine_aa = this.network.agent.noopde
	})


	it('Alice tries to withdraw but fails', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				withdraw: 1,
			}
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.equal("support for decision_engine_aa not removed yet")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null

	})

	it('Alice tries to untie her vote too early but fails', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				name: this.name,
			}
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.equal("you cannot change your vote yet")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null

	})


	it('Alice waits for 30 days and unties her vote successfully', async () => {
		const { time_error } = await this.network.timetravel({shift: '30d'})
		expect(time_error).to.be.undefined

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				name: this.name,
			}
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.governance_aa)
		console.log(vars)
		expect(vars['support_' + this.name + '_' + this.value]).to.be.equal(0)
		expect(vars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.undefined
		expect(vars['leader_' + this.name]).to.be.equal(this.value)
		expect(vars['balance_' + this.aliceAddress]).to.be.equal(this.shares)
		expect(vars[this.name]).to.be.equal(this.value)

	})

	it('Alice withdraws successfully', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				withdraw: 1,
			}
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.alice.readAAStateVars(this.governance_aa)
		console.log(vars)
		expect(vars['support_' + this.name + '_' + this.value]).to.be.equal(0)
		expect(vars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.undefined
		expect(vars['leader_' + this.name]).to.be.equal(this.value)
		expect(vars['balance_' + this.aliceAddress]).to.be.equal(0)
		expect(vars[this.name]).to.be.equal(this.value)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([{
			address: this.aliceAddress,
			asset: this.shares_asset,
			amount: this.shares,
		}])

	})

	it('1 year later, Alice buys more of the tokens2, the new DE does nothing', async () => {
		const { time_error } = await this.network.timetravel({shift: '360d'})
		expect(time_error).to.be.undefined

		const initial_p2 = round(this.p2, 16)
		const tokens1 = 0
		const tokens2 = 10e2
		const stable_tokens = tokens2
		const { amount, fee, fee_percent } = this.buy(tokens1, tokens2)

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.curve_aa,
			amount: amount + fee + network_fee + aa2aa_fee,
			data: {
				tokens2: tokens2,
				tokens2_to: this.deposit_aa,
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

		const { vars } = await this.alice.readAAStateVars(this.curve_aa)
		console.log(vars)
		expect(vars['supply1']).to.be.equal(this.supply1)
		expect(vars['supply2']).to.be.equal(this.supply2)
		expect(vars['reserve']).to.be.equal(this.reserve)
		expect(vars['slow_capacity']).to.be.equal(this.slow_capacity)
		expect(vars['fast_capacity']).to.be.equal(this.fast_capacity)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(vars['lost_peg_ts']).to.be.equal(unitObj.timestamp)
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.deposit_aa,
				asset: this.asset2,
				amount: tokens2,
			},
			{
				address: this.decision_engine_aa,
				amount: de_fee,
			},
			{
				address: this.deposit_aa,
				amount: aa2aa_fee,
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
					p2: this.p2,
					target_p2: this.target_p2,
					new_distance: round(this.distance, 15),
					turnover: amount,
					fee_percent,
					slow_capacity_share: 0.5,
				},
			},
			to: this.aliceAddress,
		})
		
		// DE does nothing
		const { response: response2 } = await this.network.getAaResponseToUnitByAA(response.response_unit, this.decision_engine_aa)
		expect(response2.response_unit).to.be.null
		expect(response2.response.responseVars.message).to.be.equal("Did nothing")

		// deposit AA opens a deposit and sends stablecoins to Alice
		const id = response.response_unit
		const { response: response3 } = await this.network.getAaResponseToUnitByAA(response.response_unit, this.deposit_aa)
		expect(response3.response_unit).to.be.validUnit
		expect(response3.response.responseVars.id).to.be.equal(id)

		const { vars: dvars } = await this.alice.readAAStateVars(this.deposit_aa)
		console.log(dvars)
		expect(dvars['supply']).to.be.equal(stable_tokens)

		const { unitObj: unitObj3 } = await this.alice.getUnitInfo({ unit: response3.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj3)).to.deep.equalInAnyOrder([{
			address: this.aliceAddress,
			asset: this.asset_stable,
			amount: stable_tokens,
		}])
		expect(dvars['deposit_' + id]).to.deep.equalInAnyOrder({
			amount: tokens2,
			stable_amount: stable_tokens,
			owner: this.aliceAddress,
			ts: unitObj.timestamp,
		})

	})


	after(async () => {
		// uncomment this line to pause test execution to get time for Obyte DAG explorer inspection
	//	await Utils.sleep(3600 * 1000)
		await this.network.stop()
	})
})
