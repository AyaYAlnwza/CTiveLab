import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// Define expected input payload
interface EmergencyRequestBody {
  roomLocation?: string;
  confidenceScore: number;
  triggerType?: 'SOS_GESTURE' | 'FALL_DETECTION' | 'MANUAL_PANIC' | 'VOICE_COMMAND';
  notes?: string;
}

/**
 * POST /api/emergency
 * Triggered when a distress/SOS gesture is recognized.
 * Creates an EmergencyLog and assigns an idle/available robot.
 */
export async function POST(request: NextRequest) {
  try {
    const body: EmergencyRequestBody = await request.json();

    const {
      roomLocation = 'Living Lab Room 101 - Smart Care Zone',
      confidenceScore,
      triggerType = 'SOS_GESTURE',
      notes = 'Signal for Help detected via client-side MediaPipe Hands vision stream.',
    } = body;

    // 1. Validation
    if (typeof confidenceScore !== 'number' || confidenceScore < 0 || confidenceScore > 1) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid confidence score. Must be a floating point number between 0.0 and 1.0.',
        },
        { status: 400 }
      );
    }

    // 2. Database Transaction: Find available robot and create emergency record
    const result = await prisma.$transaction(async (tx) => {
      // Find an idle robot with sufficient battery (> 20%)
      const availableRobot = await tx.robot.findFirst({
        where: {
          status: { in: ['IDLE', 'AVAILABLE'] },
          isOnline: true,
          batteryLevel: { gte: 20 },
        },
        orderBy: {
          batteryLevel: 'desc',
        },
      });

      let updatedRobot = null;

      // If robot available, dispatch it
      if (availableRobot) {
        updatedRobot = await tx.robot.update({
          where: { id: availableRobot.id },
          data: {
            status: 'DISPATCHED',
            currentRoom: roomLocation,
            lastHeartbeat: new Date(),
          },
        });
      }

      // Create Emergency Log record
      const emergencyLog = await tx.emergencyLog.create({
        data: {
          roomLocation,
          confidenceScore,
          triggerType,
          status: availableRobot ? 'DISPATCHED' : 'PENDING',
          notes,
          robotAssignedId: availableRobot?.id ?? null,
        },
        include: {
          robotAssigned: true,
        },
      });

      return { emergencyLog, assignedRobot: updatedRobot };
    });

    return NextResponse.json(
      {
        success: true,
        message: result.assignedRobot
          ? `Emergency response initiated. Robot '${result.assignedRobot.name}' dispatched to ${roomLocation}.`
          : `Emergency response logged for ${roomLocation}. No robot available; notification queued.`,
        data: {
          log: result.emergencyLog,
          assignedRobot: result.assignedRobot,
        },
      },
      { status: 201 }
    );
  } catch (error: any) {
    console.error('[API /api/emergency] Error processing emergency trigger:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Internal Server Error while dispatching emergency responder.',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/emergency
 * Retrieves recent emergency logs for the dashboard panel.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '20', 10), 100);

    const [logs, availableRobotsCount, dispatchedRobotsCount] = await Promise.all([
      prisma.emergencyLog.findMany({
        take: limit,
        orderBy: { timestamp: 'desc' },
        include: {
          robotAssigned: {
            select: {
              id: true,
              name: true,
              status: true,
              batteryLevel: true,
              currentRoom: true,
            },
          },
        },
      }),
      prisma.robot.count({
        where: { status: { in: ['IDLE', 'AVAILABLE'] }, isOnline: true },
      }),
      prisma.robot.count({
        where: { status: 'DISPATCHED', isOnline: true },
      }),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        logs,
        fleetStatus: {
          availableRobots: availableRobotsCount,
          dispatchedRobots: dispatchedRobotsCount,
        },
      },
    });
  } catch (error: any) {
    console.error('[API /api/emergency] Error fetching emergency logs:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to retrieve emergency logs.',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}
