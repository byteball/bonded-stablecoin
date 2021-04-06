const path = require('path')
// eslint-disable-next-line no-unused-vars
const { Testkit, Utils } = require('aa-testkit')
const formulaCommon = require('ocore/formula/common.js');
const { Network } = Testkit({
	TESTDATA_DIR: path.join(__dirname, '../testdata'),
})

const network_fee = 4000

function round(n, precision) {
	return parseFloat(n.toFixed(precision));
}

describe('Governance proposal', function () {
	this.timeout(120 * 1000)

	before(async () => {
		this.network = await Network.create()
			.with.numberOfWitnesses(1)
			.with.agent({ bs: path.join(__dirname, '../decision-engine/bonded-stablecoin.oscript') })
			.with.agent({ bsf: path.join(__dirname, '../decision-engine/bonded-stablecoin-factory.oscript') })
			.with.agent({ fund: path.join(__dirname, '../decision-engine/stability-fund.oscript') })
			.with.agent({ de: path.join(__dirname, '../decision-engine/decision-engine.oscript') })
			.with.agent({ governance: path.join(__dirname, '../decision-engine/governance.oscript') })
			.with.agent({ stable: path.join(__dirname, '../decision-engine/stable.oscript') })
			.with.wallet({ oracle: 1e9 })
			.with.wallet({ alice: 10000e9 })
			.with.wallet({ bob: 1000e9 })
			.with.wallet({ charlie: 1000e9 })
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
		this.charlie = this.network.wallet.charlie
		this.charlieAddress = await this.charlie.getAddress()
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
		expect(dfMessage.payload.GBYTE_USD).to.be.equal(price)
		await this.network.witnessUntilStable(unit)

		this.price = price
		this.target_p2 = 1/price
	})
	
	it('Bob defines a new stablecoin', async () => {
		const { error: tf_error } = await this.network.timefreeze()
		expect(tf_error).to.be.null

		this.fee_multiplier = 2
		this.interest_rate = 0.1
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
				interest_rate: this.interest_rate,
				fee_multiplier: this.fee_multiplier,
				allow_grants: true,
				oracle1: this.oracleAddress,
				feed_name1: 'GBYTE_USD',
				regular_challenging_period: 5*24*3600,
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
		expect(curve_vars['growth_factor']).to.be.equal(1)
		expect(curve_vars['dilution_factor']).to.be.undefined
		expect(curve_vars['interest_rate']).to.be.equal(0.1)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(curve_vars['rate_update_ts']).to.be.equal(unitObj.timestamp)

		this.decision_engine_aa = curve_vars['decision_engine_aa'];
		this.ts = unitObj.timestamp

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
		const r = (amount - 1000) / 1e9
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


	it('Half a year later, Bob posts a grant request', async () => {
		const { time_error } = await this.network.timetravel({shift: '180d'})
		expect(time_error).to.be.undefined

		this.grant_amount = this.shares_supply * 0.1
		const pledge = "I'm going to do this and that. For my work, I want to be paid " + this.grant_amount + " shares"

		const { unit, error } = await this.bob.sendMulti({
			messages: [{
				app: 'text',
				payload: pledge
			}],
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.bob.getUnitInfo({ unit: unit })
		const textMessage = unitObj.messages.find(m => m.app === 'text')
		expect(textMessage.payload).to.be.equal(pledge)
		await this.network.witnessUntilStable(unit)

		this.grant_request_unit = unit
	})
	
	it('Alice creates a proposal', async () => {
		this.num = 1
		const expiry = '2030-07-01'

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				add_proposal: 1,
				type: 'grant',
				recipient: this.bobAddress,
				amount: this.grant_amount,
				expiry: expiry,
				unit: this.grant_request_unit
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
		expect(vars['count_proposals']).to.be.equal(this.num)
		expect(vars['proposal_' + this.num + '_recipient']).to.be.equal(this.bobAddress)
		expect(vars['proposal_' + this.num + '_amount']).to.be.equal(this.grant_amount)
		expect(vars['proposal_' + this.num + '_unit']).to.be.equal(this.grant_request_unit)
		expect(vars['proposal_' + this.num + '_expiry']).to.be.equal(expiry)

		const { unitObj } = await this.alice.getUnitInfo({ unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))

	})

	it('Alice votes for the proposal', async () => {
		const shares = Math.floor(this.shares_supply * 0.25)
		const name = 'proposal'
		const value = this.num

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

		this.challenging_period_start_ts = unitObj.timestamp
		this.name = name
		this.value = value
		this.alice_shares_locked = shares
	})


	it('Bob tries to commit too early but unsuccessful', async () => {
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

	it('Bob waits for 5 days and fails again due to insufficient support', async () => {
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

		expect(response.response.error).to.be.equal('not enough support for the proposal')
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null

	})

	it('Alice sends token1 to Charlie', async () => {
		const { unit, error } = await this.alice.sendMulti({
			asset: this.shares_asset,
			amount: Math.round(this.shares_supply * 0.3),
			to_address: this.charlieAddress,
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		await this.network.witnessUntilStable(unit)
	})

	it('Charlie supports Alice and also votes for the proposal', async () => {
		const shares = Math.floor(this.shares_supply * 0.3)
		const name = 'proposal'
		const value = this.num

		const { unit, error } = await this.charlie.sendMulti({
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

		const { vars } = await this.charlie.readAAStateVars(this.governance_aa)
		console.log(vars)
		expect(vars['support_' + name + '_' + value]).to.be.equal(Math.floor(0.55 * this.shares_supply))
		expect(vars['support_' + name + '_' + value + '_' + this.charlieAddress]).to.be.equal(shares)
		expect(vars['leader_' + name]).to.be.equal(this.num)
		expect(vars['balance_' + this.charlieAddress]).to.be.equal(shares)

		const { unitObj } = await this.charlie.getUnitInfo({ unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(vars['challenging_period_start_ts_' + name]).to.be.equal(this.challenging_period_start_ts)

	})


	it('Bob tries again and commits successfully', async () => {
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
		expect(vars['support_' + this.name + '_' + this.value]).to.be.equal(Math.floor(this.shares_supply * 0.55))
		expect(vars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.equal(Math.floor(this.shares_supply * 0.25))
		expect(vars['support_' + this.name + '_' + this.value + '_' + this.charlieAddress]).to.be.equal(Math.floor(this.shares_supply * 0.3))
		expect(vars['leader_' + this.name]).to.be.equal(this.value)
		expect(vars[this.name]).to.be.undefined
		expect(vars['proposal_' + this.num + '_approved']).to.be.equal(1)
		expect(vars['balance_' + this.aliceAddress]).to.be.equal(Math.floor(this.shares_supply * 0.25))
		expect(vars['balance_' + this.charlieAddress]).to.be.equal(Math.floor(this.shares_supply * 0.3))

		this.initial_shares_supply = this.shares_supply
		this.shares_supply += this.grant_amount

		const { vars: cvars } = await this.bob.readAAStateVars(this.curve_aa)
		console.log(cvars)
		expect(cvars[this.name]).to.be.undefined
		expect(cvars['rate_update_ts']).to.be.equal(this.ts)
		expect(cvars['growth_factor']).to.be.equal(1)
		expect(cvars['supply1']).to.be.equal(this.supply1)
		expect(cvars['dilution_factor']).to.be.undefined

		const { vars: fvars } = await this.bob.readAAStateVars(this.fund_aa)
		console.log(fvars)
		expect(fvars['shares_supply']).to.be.eq(this.shares_supply)

		// DE to fund
		const { response: response2 } = await this.network.getAaResponseToUnit(response.response_unit)
		expect(response2.response_unit).to.be.validUnit

		// fund to bob
		const { response: response3 } = await this.network.getAaResponseToUnit(response2.response_unit)
		expect(response3.response_unit).to.be.validUnit
		const { unitObj } = await this.bob.getUnitInfo({ unit: response3.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.shares_asset,
				address: this.bobAddress,
				amount: this.grant_amount,
			},
		])

		const balances = await this.bob.getOutputsBalanceOf(this.bobAddress);
		expect(balances[this.shares_asset].total).to.be.eq(this.grant_amount)
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

		expect(response.response.error).to.be.equal("support for proposal not removed yet")
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
		expect(vars['support_' + this.name + '_' + this.value]).to.be.equal(Math.floor(0.3 * this.initial_shares_supply)) // charlie
		expect(vars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.undefined
		expect(vars['leader_' + this.name]).to.be.equal(this.value)
		expect(vars['balance_' + this.aliceAddress]).to.be.equal(this.alice_shares_locked)
		expect(vars[this.name]).to.be.undefined
		expect(vars['proposal_' + this.num + '_approved']).to.be.equal(1)

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
		expect(vars['support_' + this.name + '_' + this.value]).to.be.equal(Math.floor(0.3 * this.initial_shares_supply)) // charlie
		expect(vars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.undefined
		expect(vars['leader_' + this.name]).to.be.equal(this.value)
		expect(vars['balance_' + this.aliceAddress]).to.be.equal(0)
		expect(vars[this.name]).to.be.undefined
		expect(vars['proposal_' + this.num + '_approved']).to.be.equal(1)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([{
			address: this.aliceAddress,
			asset: this.shares_asset,
			amount: this.alice_shares_locked,
		}])

	})


	it("Charlie buys shares in the fund and pays a new (lower) share price", async () => {
		const balances = await this.charlie.getOutputsBalanceOf(this.fund_aa);
		expect(balances[this.asset1].total).to.be.eq(this.supply1)
		const bytes_balance = balances.base.total
		const p1 = this.getP1(this.supply1, this.supply2)
		const share_price_in_gb = (bytes_balance / 1e9 + p1 * this.supply1 / 1e9) / this.shares_supply
		const share_price_in_bytes = share_price_in_gb * 1e9

		const amount = 1e9
		const shares = Math.floor(amount / share_price_in_bytes)
		
		const { unit, error } = await this.charlie.sendBytes({
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
		const { unitObj } = await this.charlie.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.fund_aa,
				amount: amount + 5000,
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.be.deep.equalInAnyOrder({
			payments: [{
				asset: this.shares_asset, address: this.charlieAddress, amount: shares
			}],
		})

		// fund to charlie
		const { response: response2 } = await this.network.getAaResponseToUnit(response.response_unit)
		const { unitObj: unitObj2 } = await this.charlie.getUnitInfo({ unit: response2.response_unit })
		expect(Utils.getExternalPayments(unitObj2)).to.deep.equalInAnyOrder([
			{
				asset: this.shares_asset,
				address: this.charlieAddress,
				amount: shares,
			},
		])
		expect(unitObj2.messages.find(m => m.app === 'data')).to.be.undefined

		this.shares_supply += shares
		const { vars: fund_vars } = await this.charlie.readAAStateVars(this.fund_aa)
		expect(fund_vars['shares_supply']).to.be.eq(this.shares_supply)

	})


	after(async () => {
		// uncomment this line to pause test execution to get time for Obyte DAG explorer inspection
	//	await Utils.sleep(3600 * 1000)
		await this.network.stop()
	})
})
