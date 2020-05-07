import {
  DataObject,
  Entity,
  EntityCrudRepository,
  Getter,
  HasManyDefinition,
} from '../..';
import {
  createTargetConstraint,
  createThroughConstraint,
  resolveHasManyThroughMetadata,
} from './has-many-through.helpers';
import {
  DefaultHasManyThroughRepository,
  HasManyThroughRepository,
} from './has-many-through.repository';

export type HasManyThroughRepositoryFactory<
  TargetEntity extends Entity,
  TargetID,
  ThroughEntity extends Entity,
  ForeignKeyType
> = (
  fkValue: ForeignKeyType,
) => HasManyThroughRepository<TargetEntity, TargetID, ThroughEntity>;

export function createHasManyThroughRepositoryFactory<
  Target extends Entity,
  TargetID,
  Through extends Entity,
  ThroughID,
  ForeignKeyType
>(
  relationMetadata: HasManyDefinition,
  targetRepositoryGetter: Getter<EntityCrudRepository<Target, TargetID>>,
  throughRepositoryGetter: Getter<EntityCrudRepository<Through, ThroughID>>,
): HasManyThroughRepositoryFactory<Target, TargetID, Through, ForeignKeyType> {
  const meta = resolveHasManyThroughMetadata(relationMetadata);
  const result = function (fkValue: ForeignKeyType) {
    function getTargetContraint(
      throughInstances: Through[],
    ): DataObject<Target> {
      return createTargetConstraint<Target, Through>(meta, throughInstances);
    }
    function getThroughConstraint(
      targetInstance?: Target,
    ): DataObject<Through> {
      const constriant: DataObject<Through> = createThroughConstraint<
        Through,
        ForeignKeyType
      >(meta, fkValue);
      return constriant;
    }

    return new DefaultHasManyThroughRepository<
      Target,
      TargetID,
      EntityCrudRepository<Target, TargetID>,
      Through,
      ThroughID,
      EntityCrudRepository<Through, ThroughID>
    >(
      targetRepositoryGetter,
      throughRepositoryGetter,
      getTargetContraint,
      getThroughConstraint,
    );
  };
  return result;
}
