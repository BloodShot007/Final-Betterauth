// test.js
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    console.log("DATABASE_URL:", process.env.DATABASE_URL);  // should not be undefined
    const users = await prisma.user.findMany();
    console.log("Users:", users);
  } catch (e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
})();
