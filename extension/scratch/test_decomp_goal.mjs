const { decomposeTaskGoal } = await import('../dist/background/localAgent.js');

async function main() {
  const goal = 'Find my latest Amazon transaction.';
  console.log('Testing decomposeTaskGoal with goal:', goal);
  const plan = await decomposeTaskGoal(goal);
  console.log('Result plan:', JSON.stringify(plan, null, 2));
}

main().catch(console.error);
