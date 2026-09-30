import { PrismaClient, RobotStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding initial Living Lab Humanoid Fleet...');

  // Upsert sample robots for the HRI Hackathon Demo
  const robot1 = await prisma.robot.upsert({
    where: { id: 'cuid-robot-medic-01' },
    update: {},
    create: {
      id: 'cuid-robot-medic-01',
      name: 'Humanoid-Medic-01',
      model: 'HRI-CareUnit-V2',
      status: RobotStatus.AVAILABLE,
      batteryLevel: 98,
      currentRoom: 'Docking Station A (Main Hall)',
      isOnline: true,
    },
  });

  const robot2 = await prisma.robot.upsert({
    where: { id: 'cuid-robot-walker-02' },
    update: {},
    create: {
      id: 'cuid-robot-walker-02',
      name: 'Walker-Bot-Alpha',
      model: 'HRI-Mobility-V1',
      status: RobotStatus.IDLE,
      batteryLevel: 85,
      currentRoom: 'Rehab Suite Storage',
      isOnline: true,
    },
  });

  console.log('✅ Robots seeded successfully:', [robot1.name, robot2.name]);
}

main()
  .catch((e) => {
    console.error('❌ Seeding error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
